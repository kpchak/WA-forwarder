require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large media files
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Disable caching for script.js to ensure fresh code loads
app.use('/script.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static('public'));

// WhatsApp client setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
  }
});

let qrCodeData = null;
let isClientReady = false;
let targetPhoneNumbers = []; // Changed to array to store multiple phone numbers

// Google Sheets configuration
const GOOGLE_SHEETS_CONFIG = {
  // You'll need to set these environment variables or create a config file
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL || '',
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
  },
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || '',
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets'
  ]
};

// Customer groups storage
let customerGroups = {};
let attendanceData = {}; // Format: { "groupName": { "customerPhone": { "YYYY-MM": [{dates}, ...] } } }

// Scheduling
const SCHEDULE_FILE_PATH = path.join(__dirname, 'scheduled-messages.json');
const SCHEDULE_CHECK_INTERVAL = 60 * 1000; // 1 minute
let scheduledMessages = [];
let scheduleChecker = null;
let isProcessingSchedules = false;

// Memory management constants
const MAX_MESSAGES_PER_REQUEST = 1000; // Maximum messages to return per request
const MAX_MESSAGES_PER_CHAT = 200; // Maximum messages to fetch per chat
const MEMORY_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const MEMORY_WARNING_THRESHOLD = 0.9; // Warn if memory usage exceeds 90% of limit

// Google Sheets caching
let customerGroupsCache = null;
let customerGroupsCacheTime = 0;
const CUSTOMER_GROUPS_CACHE_TTL = Infinity; // Cache forever until manual refresh

// WhatsApp client events
client.on('qr', (qr) => {
  console.log('QR Code received');
  qrCodeData = qr;
  
  // Generate QR code image
  QRCode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Error generating QR code:', err);
      return;
    }
    
    console.log('📱 QR Code generated - client needs authentication');
    // Only emit QR code if client is not ready
    // This prevents showing QR during temporary disconnects when session is still valid
    if (!isClientReady) {
      console.log('📤 Emitting QR code to clients (client not ready)');
      io.emit('qrCode', { qrData: qr, qrImage: url });
    } else {
      console.log('⚠️ QR code generated but client is ready - not emitting (likely temporary)');
    }
  });
});

client.on('ready', () => {
  console.log('WhatsApp client is ready!');
  isClientReady = true;
  io.emit('clientReady', { status: 'connected' });
});

client.on('authenticated', () => {
  console.log('WhatsApp client authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
  io.emit('authFailure', { message: msg });
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp client disconnected:', reason);
  isClientReady = false;
  
  // Determine if this is a permanent session closure or temporary disconnect
  const requiresReconnect = reason === 'LOGOUT' || reason === 'NAVIGATION' || reason?.includes('Session closed');
  
  io.emit('clientDisconnected', { 
    reason: reason || 'Connection lost',
    requiresReconnect: requiresReconnect 
  });
  
  // If it's a temporary disconnect, the client will try to auto-reconnect
  // Don't clear the session immediately - let LocalAuth handle reconnection
  if (requiresReconnect) {
    console.log('⚠️ Session requires re-authentication');
  } else {
    console.log('⏳ Temporary disconnect - waiting for auto-reconnection...');
  }
});

// Listen for messages
client.on('message', async (message) => {
  // Check if message is from any of the target phone numbers
  const isFromTarget = targetPhoneNumbers.some(phoneNumber => {
    const formattedNumber = phoneNumber.replace(/\D/g, '');
    return message.from.includes(formattedNumber);
  });
  
  if (isFromTarget) {
    const messageData = {
      from: message.from,
      body: message.body || '',
      timestamp: message.timestamp,
      type: message.type,
      isFromMe: message.fromMe,
      hasMedia: message.hasMedia,
      mediaUrl: null,
      mediaFilename: null,
      mediaMimetype: null
    };

    // Handle media messages
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          messageData.mediaUrl = `data:${media.mimetype};base64,${media.data}`;
          messageData.mediaFilename = media.filename || `media_${message.id._serialized}`;
          messageData.mediaMimetype = media.mimetype;
        }
      } catch (error) {
        console.error('Error downloading media:', error);
        messageData.mediaError = 'Failed to download media';
      }
    }
    
    io.emit('newMessage', messageData);
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/set-phone', (req, res) => {
  console.log('Received set-phone request:', req.body);
  const { phoneNumber, phoneNumbers } = req.body;
  
  // Handle single phone number
  if (phoneNumber) {
    // Validate phone number format - accept:
    // 1. Phone numbers starting with + (e.g., +1234567890)
    // 2. Phone numbers with @c.us (e.g., 1234567890@c.us)
    // 3. Group IDs with @g.us (e.g., 120363123456789012@g.us)
    if (!phoneNumber.startsWith('+') && !phoneNumber.includes('@c.us') && !phoneNumber.includes('@g.us')) {
      console.log('Error: Invalid phone number format');
      return res.status(400).json({ error: 'Phone number must be in format +1234567890, 1234567890@c.us, or 120363123456789012@g.us' });
    }
    
    if (!targetPhoneNumbers.includes(phoneNumber)) {
      targetPhoneNumbers.push(phoneNumber);
      console.log('Added phone number:', phoneNumber);
    }
  }
  
  // Handle multiple phone numbers
  if (phoneNumbers && Array.isArray(phoneNumbers)) {
    phoneNumbers.forEach(num => {
      // Accept phone numbers with +, @c.us, or @g.us
      if ((num.startsWith('+') || num.includes('@c.us') || num.includes('@g.us')) && !targetPhoneNumbers.includes(num)) {
        targetPhoneNumbers.push(num);
        console.log('Added phone number:', num);
      }
    });
  }
  
  console.log('Current target phone numbers:', targetPhoneNumbers);
  console.log('Client ready status:', isClientReady);
  
  res.json({ 
    success: true, 
    phoneNumbers: targetPhoneNumbers,
    clientReady: isClientReady 
  });
});

app.get('/messages/:phoneNumber', async (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  try {
    console.log('Fetching messages for:', phoneNumber);
    
    let chatId;
    
    // Check if it's a group ID (contains @g.us) or a regular contact
    if (phoneNumber.includes('@g.us')) {
      // It's already a group ID
      chatId = phoneNumber;
      console.log('Chat ID (Group):', chatId);
    } else {
      // Format phone number properly for individual contact
      let formattedNumber = phoneNumber;
      if (phoneNumber.startsWith('+')) {
        formattedNumber = phoneNumber.substring(1);
      }
      
      // Remove any non-digit characters except +
      formattedNumber = formattedNumber.replace(/\D/g, '');
      
      chatId = `${formattedNumber}@c.us`;
      console.log('Chat ID (Contact):', chatId);
    }
    
    const chat = await client.getChatById(chatId);
    console.log('Chat found:', chat.name || 'Unknown');
    
    // Dynamic time window and limit
    const days = parseInt(req.query.days) || 7;
    const estimatedLimit = Math.max(50, days * 50);
    console.log(`Loading messages with days=${days}, estimatedLimit=${estimatedLimit}`);

    const messages = await chat.fetchMessages({ limit: estimatedLimit });
    console.log('Messages fetched:', messages.length);
    
    // Filter messages within requested window
    const now = Date.now();
    const sinceMs = now - (days * 24 * 60 * 60 * 1000);
    console.log(`Time calculation: now=${new Date(now).toLocaleString()}, sinceMs=${new Date(sinceMs).toLocaleString()}, days=${days}`);
    
    const recentMessages = messages.filter(msg => {
      const messageDate = (msg.timestamp || 0) * 1000; // to ms
      const isWithinTimeRange = messageDate >= sinceMs;
      // Include both incoming and outgoing messages - client will handle filtering
      return isWithinTimeRange;
    });
    
    // Debug: Count fromMe messages
    const fromMeCount = recentMessages.filter(msg => msg.fromMe).length;
    const fromCustomerCount = recentMessages.filter(msg => !msg.fromMe).length;
    console.log(`[DEBUG] Recent messages (last ${days} days): ${recentMessages.length} total (${fromMeCount} from You, ${fromCustomerCount} from customers)`);
    if (messages.length > 0) {
      const oldest = new Date(Math.min(...messages.map(m => (m.timestamp || 0) * 1000))).toLocaleString();
      const newest = new Date(Math.max(...messages.map(m => (m.timestamp || 0) * 1000))).toLocaleString();
      console.log('Fetched date range:', { oldest, newest, days });
    }
    
    const formattedMessages = await Promise.all(recentMessages.map(async (msg) => {
      // Get sender information
      let senderName = 'Unknown';
      let senderPhone = '';
      
      if (msg.fromMe) {
        senderName = 'You';
        senderPhone = 'Me';
      } else {
        // Extract phone number from the 'from' field
        senderPhone = msg.from.replace('@c.us', '').replace('@g.us', '');
        
        // Try to get contact name (with timeout to prevent hanging)
        try {
          const contactPromise = client.getContactById(msg.from);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 2000)
          );
          const contact = await Promise.race([contactPromise, timeoutPromise]);
          if (contact && contact.name) {
            senderName = contact.name;
          } else {
            senderName = senderPhone;
          }
        } catch (error) {
          // If timeout or error, just use phone number
          senderName = senderPhone;
        }
      }
      
      const messageData = {
        id: msg.id._serialized,
        body: msg.body || '',
        from: msg.from,
        timestamp: msg.timestamp,
        type: msg.type,
        isFromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        mediaUrl: null,
        mediaFilename: null,
        mediaMimetype: null,
        senderName: senderName,
        senderPhone: senderPhone,
        chatName: chat.name || 'Unknown'
      };

      // Skip media download for now to improve performance
      // Media can be downloaded on-demand when user clicks on a message
      if (msg.hasMedia) {
        messageData.mediaNote = 'Media available - click to download';
      }

      return messageData;
    }));
    
    res.json({ messages: formattedMessages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    console.error('Error details:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch messages', 
      details: error.message,
      phoneNumber: phoneNumber 
    });
  }
});

// New endpoint to get merged messages from all phone numbers
async function handleMergedMessagesRequest(req, res) {
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }

  // Allow clients to specify the list explicitly (fallback to server-side list)
  const bodyPhoneNumbers = Array.isArray(req.body?.phoneNumbers)
    ? req.body.phoneNumbers
        .filter(num => typeof num === 'string' && num.trim() !== '')
        .map(num => num.trim())
    : [];

  const queryPhoneNumbers = Array.isArray(req.query?.phoneNumbers)
    ? req.query.phoneNumbers
    : [];

  const contactsToProcess = bodyPhoneNumbers.length > 0
    ? bodyPhoneNumbers
    : (queryPhoneNumbers.length > 0 ? queryPhoneNumbers : targetPhoneNumbers);

  if (!contactsToProcess || contactsToProcess.length === 0) {
    return res.status(400).json({ error: 'No phone numbers set' });
  }

  // Set a timeout for the entire request
  const timeout = setTimeout(() => {
    console.log('Request timeout - taking too long to fetch messages');
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout - too many messages to process' });
    }
  }, 120000); // 120 second timeout (2 minutes)

  try {
    console.log('Fetching merged messages for:', contactsToProcess);
    console.log(`Processing ${contactsToProcess.length} contacts/groups`);

    let allMessages = [];
    const messageIds = new Set(); // To track unique messages

    // Fetch messages from each contact/group
    for (let i = 0; i < contactsToProcess.length; i++) {
      const phoneNumber = contactsToProcess[i];
      console.log(`Processing contact/group ${i + 1}/${contactsToProcess.length}: ${phoneNumber}`);

      try {
        // Handle both individual contacts (@c.us) and groups (@g.us)
        let chatId = phoneNumber;

        // If it doesn't have @ in it, assume it's an individual contact
        if (!phoneNumber.includes('@')) {
          let formattedNumber = phoneNumber;
          if (phoneNumber.startsWith('+')) {
            formattedNumber = phoneNumber.substring(1);
          }
          formattedNumber = formattedNumber.replace(/\D/g, '');
          chatId = `${formattedNumber}@c.us`;
        }

        console.log('Fetching messages from contact/group ID:', chatId);

        console.log(`Getting chat for ID: ${chatId}`);
        
        // Check if client is still ready before attempting to get chat
        if (!isClientReady) {
          console.error(`Client not ready when trying to fetch chat for ${chatId}`);
          throw new Error('WhatsApp client not ready. Session may have been closed.');
        }
        
        const chat = await client.getChatById(chatId);
        const chatName = chat?.name || 'Unknown';
        console.log('Chat found:', chatName);

        // Check if chat is valid
        if (!chat) {
          console.log(`Chat not found for ${phoneNumber}, skipping...`);
          continue;
        }

        // Send progress update to client with name
        if (io && io.engine && io.engine.clientsCount > 0) {
          io.emit('message-progress', {
            current: i + 1,
            total: contactsToProcess.length,
            phoneNumber: phoneNumber,
            chatName: chatName
          });
        }

        console.log(`Fetching messages for ${phoneNumber}...`);

        // Determine time range filter
        let days = 0;
        let timeFilterStart = 0;
        let timeFilterEnd = 0;

        if (req.query.datetimeFilter === 'true') {
          // Check if we have from/to timestamps for precise filtering
          if (req.query.from && req.query.to) {
            timeFilterStart = parseInt(req.query.from);
            timeFilterEnd = parseInt(req.query.to);
            // Calculate days for fetch limit estimation
            days = Math.ceil((timeFilterEnd - timeFilterStart) / (1000 * 60 * 60 * 24));
            console.log(`Using precise datetime filter from=${new Date(timeFilterStart).toLocaleString()}, to=${new Date(timeFilterEnd).toLocaleString()}, days=${days}`);
          } else if (req.query.days) {
            // Fallback to days-based filtering
            days = parseInt(req.query.days) || 7;
            const now = Date.now();
            timeFilterStart = now - (days * 24 * 60 * 60 * 1000);
            timeFilterEnd = now;
            console.log(`Using days-based filter: days=${days}`);
          }
        } else if (req.query.hours) {
          // Hours filter
          const hours = parseInt(req.query.hours);
          days = Math.ceil(hours / 24);
          const now = Date.now();
          timeFilterStart = now - (hours * 60 * 60 * 1000);
          timeFilterEnd = now;
          console.log(`Using hours-based filter: hours=${hours}, days=${days}`);
        }

        // Calculate appropriate limit based on time range (roughly 50 messages per day)
        // If no filter, load minimum 30 to ensure we have enough data
        // Cap at MAX_MESSAGES_PER_CHAT to prevent memory issues
        const estimatedLimit = days > 0 ? Math.min(MAX_MESSAGES_PER_CHAT, Math.max(50, days * 50)) : Math.min(MAX_MESSAGES_PER_CHAT, 200); // Default to 200 messages if no filter, capped
        const messages = await chat.fetchMessages({ limit: estimatedLimit });
        console.log(`Messages fetched from ${phoneNumber}:`, messages.length);

        // Debug: Show date range of fetched messages
        if (messages.length > 0) {
          const oldestMsg = messages[messages.length - 1];
          const newestMsg = messages[0];
          console.log(`Date range for ${phoneNumber}:`, {
            oldest: new Date(oldestMsg.timestamp * 1000).toLocaleString(),
            newest: new Date(newestMsg.timestamp * 1000).toLocaleString(),
            filterStart: timeFilterStart > 0 ? new Date(timeFilterStart).toLocaleString() : 'none'
          });
        } else {
          console.log(`No messages found for ${phoneNumber} - chat might be empty or inaccessible`);
        }

        const recentMessages = messages.filter(msg => {
          const messageDate = msg.timestamp * 1000;
          const isWithinTimeRange = timeFilterStart === 0 || (messageDate >= timeFilterStart && messageDate <= timeFilterEnd);
          // Include both incoming and outgoing messages - client will handle filtering
          return isWithinTimeRange;
        });

        if (timeFilterStart > 0 && timeFilterEnd > 0) {
          console.log(`Recent messages from ${phoneNumber} (custom range ${new Date(timeFilterStart).toLocaleString()} to ${new Date(timeFilterEnd).toLocaleString()}):`, recentMessages.length);
        } else {
          console.log(`Recent messages from ${phoneNumber} (last ${days} days):`, recentMessages.length);
        }

        // Additional debugging for empty results
        if (recentMessages.length === 0 && messages.length > 0) {
          console.log(`All ${messages.length} messages from ${phoneNumber} are older than ${days} days`);
          // Show some sample message dates
          const sampleMessages = messages.slice(0, 3);
          sampleMessages.forEach((msg, index) => {
            console.log(`Sample message ${index + 1} date:`, new Date(msg.timestamp * 1000).toLocaleString());
          });
        }

        // Debug: Show some message details
        if (recentMessages.length > 0) {
          console.log(`Sample message from ${phoneNumber}:`, {
            id: recentMessages[0].id._serialized,
            body: recentMessages[0].body?.substring(0, 50) + '...',
            timestamp: new Date(recentMessages[0].timestamp * 1000).toLocaleString()
          });
        } else {
          console.log(`No recent messages found for ${phoneNumber}`);
        }

        // Debug: Count fromMe messages
        const fromMeCount = recentMessages.filter(msg => msg.fromMe).length;
        const fromCustomerCount = recentMessages.filter(msg => !msg.fromMe).length;
        console.log(`[DEBUG] Messages from ${phoneNumber}: ${fromMeCount} from You, ${fromCustomerCount} from customers`);

        // Process messages and add to allMessages
        for (const msg of recentMessages) {
          // Skip if we've already seen this message (by ID)
          if (messageIds.has(msg.id._serialized)) {
            continue;
          }

          messageIds.add(msg.id._serialized);

          // Get sender information
          let senderName = 'Unknown';
          let senderPhone = '';

          if (msg.fromMe) {
            console.log(`[DEBUG] Processing message from You: ${msg.body?.substring(0, 50)}...`);
            senderName = 'You';
            senderPhone = 'Me';
          } else {
            // Extract phone number from the 'from' field
            senderPhone = msg.from.replace('@c.us', '').replace('@g.us', '');

            // Try to get contact name (with shorter timeout to prevent hanging)
            try {
              const contactPromise = client.getContactById(msg.from);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 500) // Reduced from 2000ms to 500ms
              );
              const contact = await Promise.race([contactPromise, timeoutPromise]);
              if (contact && contact.name) {
                senderName = contact.name;
              } else {
                senderName = senderPhone;
              }
            } catch (error) {
              // If timeout or error, just use phone number
              senderName = senderPhone;
            }
          }

          const messageData = {
            id: msg.id._serialized,
            body: msg.body || '',
            from: msg.from,
            timestamp: msg.timestamp,
            type: msg.type,
            isFromMe: msg.fromMe,
            hasMedia: msg.hasMedia,
            mediaUrl: null,
            mediaFilename: null,
            mediaMimetype: null,
            sourcePhone: phoneNumber, // Track which phone number this came from
            senderName: senderName,
            senderPhone: senderPhone,
            chatName: chatName
          };

          // Skip media download for now to improve performance
          // Media can be downloaded on-demand when user clicks on a message
          if (msg.hasMedia) {
            messageData.mediaNote = 'Media available - click to download';
          }

          allMessages.push(messageData);
        }
      } catch (error) {
        console.error(`Error fetching messages from ${phoneNumber}:`, error);
        console.error('Full error details:', error.message);
        
        // Check if it's a session closed error
        const isSessionClosed = error.message?.includes('Session closed') || 
                               error.message?.includes('Protocol error') ||
                               error.message?.includes('Runtime.callFunctionOn');
        
        if (isSessionClosed) {
          console.error('⚠️ WhatsApp session has been closed. Stopping message fetch.');
          // Update client status
          isClientReady = false;
          
          // Emit disconnect event
          if (io && io.engine && io.engine.clientsCount > 0) {
            io.emit('clientDisconnected', {
              reason: 'Session closed',
              requiresReconnect: true
            });
          }
          
          // Return error response
          clearTimeout(timeout);
          if (!res.headersSent) {
            return res.status(503).json({
              error: 'WhatsApp session has been closed',
              message: 'Please refresh the page and scan the QR code again to reconnect.',
              requiresReconnect: true
            });
          }
          return;
        }
        
        // For other errors, continue with other phone numbers
        console.log(`Continuing with other contacts despite error for ${phoneNumber}...`);
      }

      // Add a small delay between requests to prevent overwhelming the API
      if (i < contactsToProcess.length - 1) {
        console.log('Waiting 25ms before next request...');
        await new Promise(resolve => setTimeout(resolve, 25)); // Reduced from 50ms to 25ms for faster loading
      }
    }

    // Sort messages by timestamp (newest first)
    allMessages.sort((a, b) => b.timestamp - a.timestamp);

    // Limit total messages to prevent memory issues
    const limitedMessages = allMessages.slice(0, MAX_MESSAGES_PER_REQUEST);
    
    if (allMessages.length > MAX_MESSAGES_PER_REQUEST) {
      console.log(`⚠️ Memory optimization: Limiting messages from ${allMessages.length} to ${MAX_MESSAGES_PER_REQUEST}`);
    }

    console.log(`Total unique messages found: ${allMessages.length} (returning ${limitedMessages.length})`);

    // Clear the timeout since we're responding
    clearTimeout(timeout);

    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      res.json({
        messages: limitedMessages,
        totalMessages: limitedMessages.length,
        totalAvailable: allMessages.length, // Let client know there are more
        phoneNumbers: contactsToProcess
      });
    }
  } catch (error) {
    console.error('Error fetching merged messages:', error);
    clearTimeout(timeout);

    // Check if it's a session closed error
    const isSessionClosed = error.message?.includes('Session closed') || 
                           error.message?.includes('Protocol error') ||
                           error.message?.includes('Runtime.callFunctionOn');
    
    if (isSessionClosed) {
      console.error('⚠️ WhatsApp session has been closed.');
      isClientReady = false;
      
      // Emit disconnect event
      if (io && io.engine && io.engine.clientsCount > 0) {
        io.emit('clientDisconnected', {
          reason: 'Session closed',
          requiresReconnect: true
        });
      }
    }

    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      if (isSessionClosed) {
        res.status(503).json({
          error: 'WhatsApp session has been closed',
          message: 'Please refresh the page and scan the QR code again to reconnect.',
          requiresReconnect: true
        });
      } else {
        res.status(500).json({
          error: 'Failed to fetch merged messages',
          details: error.message
        });
      }
    }
  }
}

app.get('/messages-merged', handleMergedMessagesRequest);
app.post('/messages-merged', handleMergedMessagesRequest);

// New endpoint to get all available chats (contacts and groups)
app.get('/chats', async (req, res) => {
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  try {
    console.log('Fetching all chats...');
    
    const chats = await client.getChats();
    console.log(`Found ${chats.length} chats`);
    
    const formattedChats = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || 'Unknown',
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body || '',
        timestamp: chat.lastMessage.timestamp,
        from: chat.lastMessage.from
      } : null
    }));
    
    // Sort by last message timestamp (most recent first)
    formattedChats.sort((a, b) => {
      if (!a.lastMessage && !b.lastMessage) return 0;
      if (!a.lastMessage) return 1;
      if (!b.lastMessage) return -1;
      return b.lastMessage.timestamp - a.lastMessage.timestamp;
    });
    
    res.json({ 
      chats: formattedChats,
      totalChats: formattedChats.length,
      groups: formattedChats.filter(chat => chat.isGroup),
      contacts: formattedChats.filter(chat => !chat.isGroup)
    });
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch chats', 
      details: error.message 
    });
  }
});

// Endpoint to download media for a specific message
app.post('/download-media', async (req, res) => {
  console.log('\n' + '='.repeat(80));
  console.log('📥 [MEDIA DOWNLOAD] Request received at:', new Date().toISOString());
  console.log('📥 [MEDIA DOWNLOAD] Request body:', JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));
  
  if (!isClientReady) {
    console.error('❌ [MEDIA DOWNLOAD] WhatsApp client not ready');
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  const { messageId, chatId } = req.body;
  
  console.log('🔍 [MEDIA DOWNLOAD] Extracted parameters:', {
    messageId: messageId || 'MISSING',
    chatId: chatId || 'MISSING',
    messageIdType: typeof messageId,
    chatIdType: typeof chatId,
    messageIdLength: messageId?.length || 0,
    chatIdLength: chatId?.length || 0
  });
  
  if (!messageId || !chatId) {
    console.error('❌ [MEDIA DOWNLOAD] Missing required parameters');
    return res.status(400).json({ 
      error: 'Message ID and Chat ID are required',
      received: { messageId: !!messageId, chatId: !!chatId }
    });
  }
  
  try {
    console.log(`\n🔍 [MEDIA DOWNLOAD] Starting download process`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Chat ID: ${chatId}`);
    
    // Validate chatId format
    if (!chatId || (!chatId.includes('@c.us') && !chatId.includes('@g.us'))) {
      console.error(`❌ [MEDIA DOWNLOAD] Invalid chatId format: "${chatId}"`);
      return res.status(400).json({ 
        error: 'Invalid chat ID format. Must include @c.us or @g.us',
        received: chatId,
        chatIdType: typeof chatId
      });
    }
    
    console.log(`🔍 [MEDIA DOWNLOAD] Fetching chat: ${chatId}`);
    const chat = await client.getChatById(chatId);
    if (!chat) {
      console.error(`❌ [MEDIA DOWNLOAD] Chat not found: ${chatId}`);
      return res.status(404).json({ error: 'Chat not found', chatId: chatId });
    }
    console.log(`✅ [MEDIA DOWNLOAD] Chat found: ${chat.name || chatId} (ID: ${chat.id._serialized || 'N/A'})`);
    
    console.log(`🔍 [MEDIA DOWNLOAD] Fetching messages (limit: 100)...`);
    const messages = await chat.fetchMessages({ limit: 100 });
    console.log(`✅ [MEDIA DOWNLOAD] Fetched ${messages.length} messages to search`);
    
    // Log sample of first few messages for debugging
    if (messages.length > 0) {
      console.log(`\n📋 [MEDIA DOWNLOAD] Sample messages (first 5):`);
      messages.slice(0, 5).forEach((msg, idx) => {
        console.log(`   [${idx + 1}] ID: ${msg.id._serialized}, Type: ${msg.type}, hasMedia: ${msg.hasMedia}, fromMe: ${msg.fromMe}, from: ${msg.from}, timestamp: ${msg.timestamp}`);
      });
    }
    
    // Try to find message by _serialized ID first, then by various custom formats
    console.log(`\n🔍 [MEDIA DOWNLOAD] Searching for message with ID: ${messageId}`);
    console.log(`   Message ID parts: ${messageId.split('_').join(' | ')}`);
    
    let message = null;
    let matchMethod = null;
    
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const serializedId = msg.id?._serialized;
      
      // Try exact match first
      if (serializedId === messageId) {
        matchMethod = 'exact_match';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Exact match found at index ${idx} by serialized ID: ${serializedId}`);
        break;
      }
      
      // Try matching just the serialized part if messageId contains it
      if (serializedId && messageId.includes(serializedId)) {
        matchMethod = 'substring_match';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Substring match found at index ${idx}: ${serializedId} in ${messageId}`);
        break;
      }
      
      // Try custom formats
      const customId1 = `${msg.fromMe}_${msg.from}_${serializedId || msg.timestamp}`;
      if (customId1 === messageId) {
        matchMethod = 'custom_format_1';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Custom format 1 match found at index ${idx}: ${customId1}`);
        break;
      }
      
      // Try format: fromMe_from_serializedId_timestamp@lid
      if (serializedId) {
        const customId2 = `${msg.fromMe}_${msg.from}_${serializedId}_${msg.timestamp}@lid`;
        if (customId2 === messageId) {
          matchMethod = 'custom_format_2';
          message = msg;
          console.log(`✅ [MEDIA DOWNLOAD] Custom format 2 match found at index ${idx}: ${customId2}`);
          break;
        }
        
        // Try matching parts of the ID with timestamp validation
        const messageIdParts = messageId.split('_');
        if (messageIdParts.length >= 3) {
          const fromMeMatch = messageIdParts[0] === String(msg.fromMe);
          const fromMatch = messageIdParts[1] && msg.from.includes(messageIdParts[1].replace(/@.*/, ''));
          const serializedMatch = messageIdParts.some(part => {
            const cleanPart = part.replace(/@.*/, '');
            return part === serializedId || serializedId.includes(cleanPart) || cleanPart === serializedId;
          });
          
          // Also check timestamp if present in messageId
          const timestampMatch = messageIdParts.some(part => {
            const cleanPart = part.replace(/@.*/, '');
            return cleanPart === String(msg.timestamp);
          });
          
          if (fromMeMatch && fromMatch && serializedMatch && (timestampMatch || messageIdParts.length === 3)) {
            matchMethod = 'parts_match';
            message = msg;
            console.log(`✅ [MEDIA DOWNLOAD] Parts match found at index ${idx}`);
            console.log(`   Match details: fromMe=${fromMeMatch}, from=${fromMatch}, serialized=${serializedMatch}, timestamp=${timestampMatch}`);
            break;
          }
        }
      }
    }
    
    if (message) {
      console.log(`\n✅ [MEDIA DOWNLOAD] Message found!`);
      console.log(`   Match method: ${matchMethod}`);
      console.log(`   Serialized ID: ${message.id._serialized}`);
      console.log(`   Type: ${message.type}`);
      console.log(`   hasMedia: ${message.hasMedia}`);
      console.log(`   fromMe: ${message.fromMe}`);
      console.log(`   from: ${message.from}`);
      console.log(`   timestamp: ${message.timestamp}`);
      console.log(`   body preview: ${message.body?.substring(0, 100) || 'N/A'}`);
      console.log(`   All message properties:`, Object.keys(message));
    } else {
      console.log(`\n⚠️ [MEDIA DOWNLOAD] Message not found in first 100 messages`);
    }
    
    if (!message) {
      console.log(`\n🔍 [MEDIA DOWNLOAD] Message not found in first 100, trying extended search (limit: 500)...`);
      // Try fetching more messages if not found in first 100
      const moreMessages = await chat.fetchMessages({ limit: 500 });
      console.log(`✅ [MEDIA DOWNLOAD] Fetched ${moreMessages.length} messages in extended search`);
      const message2 = moreMessages.find(msg => {
        const serializedId = msg.id?._serialized;
        
        if (serializedId === messageId) return true;
        if (serializedId && messageId.includes(serializedId)) return true;
        
        const customId1 = `${msg.fromMe}_${msg.from}_${serializedId || msg.timestamp}`;
        if (customId1 === messageId) return true;
        
        if (serializedId) {
          const customId2 = `${msg.fromMe}_${msg.from}_${serializedId}_${msg.timestamp}@lid`;
          if (customId2 === messageId) return true;
          
          // Try matching parts
          const messageIdParts = messageId.split('_');
          if (messageIdParts.length >= 2) {
            const fromMeMatch = messageIdParts[0] === String(msg.fromMe);
            const fromMatch = messageIdParts[1] && msg.from.includes(messageIdParts[1].replace(/@.*/, ''));
            const serializedMatch = messageIdParts.some(part => part === serializedId || serializedId.includes(part.replace(/@.*/, '')));
            if (fromMeMatch && fromMatch && serializedMatch) return true;
          }
        }
        
        return false;
      });
      if (message2) {
        console.log(`\n✅ [MEDIA DOWNLOAD] Message found in extended search!`);
        console.log(`   Serialized ID: ${message2.id._serialized}`);
        console.log(`   Type: ${message2.type}`);
        console.log(`   hasMedia: ${message2.hasMedia}`);
        console.log(`   fromMe: ${message2.fromMe}`);
        console.log(`   from: ${message2.from}`);
        console.log(`   timestamp: ${message2.timestamp}`);
        console.log(`   body preview: ${message2.body?.substring(0, 100) || 'N/A'}`);
        
        // Check if message has media - try multiple indicators
        const hasMediaIndicator2 = message2.hasMedia || 
                                   message2.type === 'image' || 
                                   message2.type === 'video' || 
                                   message2.type === 'audio' || 
                                   message2.type === 'document' || 
                                   message2.type === 'sticker' ||
                                   message2.type === 'ptt' ||
                                   message2.type === 'ptv' ||
                                   (message2.body && message2.body.includes('media'));
        
        console.log(`\n🔍 [MEDIA DOWNLOAD] Media indicator check:`);
        console.log(`   hasMedia: ${message2.hasMedia}`);
        console.log(`   type check: ${['image', 'video', 'audio', 'document', 'sticker', 'ptt', 'ptv'].includes(message2.type)} (type: ${message2.type})`);
        console.log(`   body contains 'media': ${message2.body?.includes('media') || false}`);
        console.log(`   Overall hasMediaIndicator: ${hasMediaIndicator2}`);
        
        // If no indicators suggest media, but user is requesting download, try anyway
        if (!hasMediaIndicator2) {
          console.warn(`\n⚠️ [MEDIA DOWNLOAD] No media indicators found, but attempting download anyway`);
          console.warn(`   Type: ${message2.type}, hasMedia: ${message2.hasMedia}`);
        } else {
          console.log(`\n📥 [MEDIA DOWNLOAD] Media indicators found, proceeding with download...`);
        }
        
        let media2;
        try {
          console.log(`\n📥 [MEDIA DOWNLOAD] Attempting to download media (extended search)...`);
          console.log(`   Message type: ${message2.type}`);
          console.log(`   Is video: ${message2.type === 'video' || message2.type === 'ptv'}`);
          
          const downloadStartTime = Date.now();
          
          // For videos, add more detailed logging and potentially increase timeout
          if (message2.type === 'video' || message2.type === 'ptv') {
            console.log(`   📹 Video message detected - this may take longer to download`);
            console.log(`   Video properties:`, {
              hasMedia: message2.hasMedia,
              type: message2.type,
              body: message2.body?.substring(0, 100) || 'N/A'
            });
          }
          
          // Download with longer timeout for videos
          // For videos, try multiple times with exponential backoff
          let retries2 = message2.type === 'video' || message2.type === 'ptv' ? 2 : 1;
          let lastError2 = null;
          
          for (let attempt = 1; attempt <= retries2; attempt++) {
            try {
              if (attempt > 1) {
                console.log(`   🔄 Retry attempt ${attempt}/${retries2} for video download (extended search)...`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
              }
              
              const downloadPromise2 = message2.downloadMedia();
              const timeoutPromise2 = new Promise((_, reject) => {
                const timeout = message2.type === 'video' || message2.type === 'ptv' ? 90000 : 30000; // 90s for video, 30s for others
                setTimeout(() => reject(new Error(`Download timeout after ${timeout}ms`)), timeout);
              });
              
              media2 = await Promise.race([downloadPromise2, timeoutPromise2]);
              const downloadDuration = Date.now() - downloadStartTime;
              
              // Check if media is null or invalid
              if (!media2 || !media2.data) {
                console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} returned null/empty media (extended search)`);
                console.error(`   Media object:`, media2 ? 'exists but no data' : 'null');
                
                if (attempt === retries2) {
                  // Last attempt, throw error
                  throw new Error('Media download returned null - media may be expired or unavailable');
                }
                // Otherwise, continue to next retry
                continue;
              }
              
              console.log(`✅ [MEDIA DOWNLOAD] Media downloaded successfully in ${downloadDuration}ms (attempt ${attempt})`);
              console.log(`   Media data length: ${media2.data.length} bytes`);
              break; // Success, exit retry loop
            } catch (attemptError) {
              lastError2 = attemptError;
              console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} failed (extended search): ${attemptError.message}`);
              
              if (attempt === retries2) {
                // Last attempt failed, throw the error
                throw attemptError;
              }
              // Otherwise, continue to next retry
            }
          }
        } catch (downloadError) {
          console.error(`\n❌ [MEDIA DOWNLOAD] Error downloading media after all attempts (extended search):`);
          console.error(`   Error message: ${downloadError.message}`);
          console.error(`   Error stack: ${downloadError.stack}`);
          console.error(`   Error name: ${downloadError.name}`);
          console.error(`   Message type: ${message2.type}`);
          console.error(`   hasMedia: ${message2.hasMedia}`);
          console.error(`   Message ID: ${message2.id?._serialized || 'N/A'}`);
          
          // Check if it's a "no media" error or a real download error
          const isNoMediaError = downloadError.message?.includes('no media') || 
                                 downloadError.message?.includes('Media not found') ||
                                 downloadError.message?.includes('does not contain media');
          
          if (isNoMediaError || (!message2.hasMedia && !hasMediaIndicator2)) {
            return res.status(400).json({ 
              error: 'Message does not contain media',
              messageType: message2.type,
              hasMedia: message2.hasMedia,
              downloadError: downloadError.message
            });
          }
          
          // Real download error
          return res.status(500).json({ 
            error: 'Failed to download media',
            details: downloadError.message,
            messageType: message2.type,
            hasMedia: message2.hasMedia
          });
        }
        
        if (!media2) {
          console.error(`❌ Failed to download media (returned null): ${messageId}`);
          return res.status(500).json({ 
            error: 'Failed to download media',
            messageType: message2.type,
            hasMedia: message2.hasMedia
          });
        }
        
        console.log(`\n✅ [MEDIA DOWNLOAD] Media downloaded successfully from extended search!`);
        console.log(`   Filename: ${media2.filename || 'unnamed'}`);
        console.log(`   Mimetype: ${media2.mimetype}`);
        console.log(`   Size: ${media2.data.length} bytes (${(media2.data.length / 1024).toFixed(2)} KB)`);
        console.log(`   Size in MB: ${(media2.data.length / (1024 * 1024)).toFixed(2)} MB`);
        
        // Check if it's a video and log additional info
        if (media2.mimetype?.startsWith('video/')) {
          console.log(`   📹 Video file detected - size: ${(media2.data.length / (1024 * 1024)).toFixed(2)} MB`);
        }
        
        // Check file size - warn if very large
        const sizeInMB2 = media2.data.length / (1024 * 1024);
        if (sizeInMB2 > 20) {
          console.warn(`   ⚠️ Large file detected (${sizeInMB2.toFixed(2)} MB) - may cause issues`);
        }
        
        try {
          const response2 = {
            success: true,
            mediaUrl: `data:${media2.mimetype};base64,${media2.data}`,
            mediaFilename: media2.filename || `media_${messageId}`,
            mediaMimetype: media2.mimetype,
            mediaSize: media2.data.length
          };
          
          // Calculate response size
          const responseSize2 = JSON.stringify(response2).length;
          const responseSizeMB2 = responseSize2 / (1024 * 1024);
          
          console.log(`   Response size: ${responseSize2} bytes (${responseSizeMB2.toFixed(2)} MB)`);
          
          if (responseSizeMB2 > 50) {
            console.error(`   ❌ Response size (${responseSizeMB2.toFixed(2)} MB) exceeds safe limit`);
            return res.status(500).json({ 
              error: 'Media file too large to send',
              details: `File size (${sizeInMB2.toFixed(2)} MB) exceeds response limit`,
              mediaSize: media2.data.length,
              responseSize: responseSize2
            });
          }
          
          return res.json(response2);
        } catch (responseError2) {
          console.error(`\n❌ [MEDIA DOWNLOAD] Error sending response (extended search):`);
          console.error(`   Error message: ${responseError2.message}`);
          console.error(`   Error stack: ${responseError2.stack}`);
          console.error(`   Media size: ${media2.data.length} bytes (${sizeInMB2.toFixed(2)} MB)`);
          
          return res.status(500).json({ 
            error: 'Failed to send media response',
            details: responseError2.message,
            mediaSize: media2.data.length,
            errorType: responseError2.name
          });
        }
      }
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Check if message has media - try multiple indicators
    console.log(`\n🔍 [MEDIA DOWNLOAD] Checking media indicators for found message:`);
    const hasMediaIndicator = message.hasMedia || 
                              message.type === 'image' || 
                              message.type === 'video' || 
                              message.type === 'audio' || 
                              message.type === 'document' || 
                              message.type === 'sticker' ||
                              message.type === 'ptt' ||
                              message.type === 'ptv' ||
                              (message.body && message.body.includes('media'));
    
    console.log(`   hasMedia flag: ${message.hasMedia}`);
    console.log(`   type check: ${['image', 'video', 'audio', 'document', 'sticker', 'ptt', 'ptv'].includes(message.type)} (type: ${message.type})`);
    console.log(`   body contains 'media': ${message.body?.includes('media') || false}`);
    console.log(`   Overall hasMediaIndicator: ${hasMediaIndicator}`);
    
    // If no indicators suggest media, but user is requesting download, try anyway
    // (might be a forwarded message or the hasMedia flag is incorrect)
    if (!hasMediaIndicator) {
      console.warn(`\n⚠️ [MEDIA DOWNLOAD] No media indicators found, but attempting download anyway`);
      console.warn(`   Type: ${message.type}, hasMedia: ${message.hasMedia}`);
    } else {
      console.log(`\n📥 [MEDIA DOWNLOAD] Media indicators found, proceeding with download...`);
    }
    
    // Try to download media - even if hasMedia is false, the message might still have media
    let media;
    try {
      console.log(`\n📥 [MEDIA DOWNLOAD] Attempting to download media...`);
      console.log(`   Message type: ${message.type}`);
      console.log(`   Is video: ${message.type === 'video' || message.type === 'ptv'}`);
      
      const downloadStartTime = Date.now();
      
      // For videos, add more detailed logging and potentially increase timeout
      if (message.type === 'video' || message.type === 'ptv') {
        console.log(`   📹 Video message detected - this may take longer to download`);
        console.log(`   Video properties:`, {
          hasMedia: message.hasMedia,
          type: message.type,
          body: message.body?.substring(0, 100) || 'N/A'
        });
      }
      
      // Download with longer timeout for videos
      // For videos, try multiple times with exponential backoff
      let retries = message.type === 'video' || message.type === 'ptv' ? 2 : 1;
      let lastError = null;
      
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`   🔄 Retry attempt ${attempt}/${retries} for video download...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          }
          
          const downloadPromise = message.downloadMedia();
          const timeoutPromise = new Promise((_, reject) => {
            const timeout = message.type === 'video' || message.type === 'ptv' ? 90000 : 30000; // 90s for video, 30s for others
            setTimeout(() => reject(new Error(`Download timeout after ${timeout}ms`)), timeout);
          });
          
          media = await Promise.race([downloadPromise, timeoutPromise]);
          const downloadDuration = Date.now() - downloadStartTime;
          
          // Check if media is null or invalid
          if (!media || !media.data) {
            console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} returned null/empty media`);
            console.error(`   Media object:`, media ? 'exists but no data' : 'null');
            
            if (attempt === retries) {
              // Last attempt, throw error
              throw new Error('Media download returned null - media may be expired or unavailable');
            }
            // Otherwise, continue to next retry
            continue;
          }
          
          console.log(`✅ [MEDIA DOWNLOAD] Media downloaded successfully in ${downloadDuration}ms (attempt ${attempt})`);
          console.log(`   Media data length: ${media.data.length} bytes`);
          break; // Success, exit retry loop
        } catch (attemptError) {
          lastError = attemptError;
          console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} failed: ${attemptError.message}`);
          
          if (attempt === retries) {
            // Last attempt failed, throw the error
            throw attemptError;
          }
          // Otherwise, continue to next retry
        }
      }
    } catch (downloadError) {
      console.error(`\n❌ [MEDIA DOWNLOAD] Error downloading media after all attempts:`);
      console.error(`   Error message: ${downloadError.message}`);
      console.error(`   Error stack: ${downloadError.stack}`);
      console.error(`   Error name: ${downloadError.name}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   hasMedia: ${message.hasMedia}`);
      console.error(`   Message ID: ${message.id?._serialized || 'N/A'}`);
      
      // Check if it's a "no media" error or a real download error
      const isNoMediaError = downloadError.message?.includes('no media') || 
                             downloadError.message?.includes('Media not found') ||
                             downloadError.message?.includes('does not contain media') ||
                             downloadError.message?.includes('Media expired');
      
      if (isNoMediaError || (!message.hasMedia && !hasMediaIndicator)) {
        return res.status(400).json({ 
          error: 'Message does not contain media',
          messageType: message.type,
          hasMedia: message.hasMedia,
          downloadError: downloadError.message
        });
      }
      
      // Real download error - provide more details
      console.error(`\n❌ [MEDIA DOWNLOAD] Returning 500 error response`);
      console.error(`   Error details: ${downloadError.message}`);
      console.error(`   Error type: ${downloadError.name}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   Has media: ${message.hasMedia}`);
      console.error(`   Retries attempted: ${retries}`);
      
      const errorResponse = { 
        error: 'Failed to download media',
        details: downloadError.message || 'Unknown error',
        messageType: message.type,
        hasMedia: message.hasMedia,
        errorType: downloadError.name || 'Error',
        retriesAttempted: retries
      };
      
      console.error(`   Error response:`, JSON.stringify(errorResponse, null, 2));
      console.log('='.repeat(80) + '\n');
      
      return res.status(500).json(errorResponse);
    }
    
    // Final safety check - this should not happen if retry logic works correctly
    if (!media || !media.data) {
      console.error(`❌ [MEDIA DOWNLOAD] Failed to download media (returned null after all retries): ${messageId}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   Has media: ${message.hasMedia}`);
      console.error(`   Message ID: ${message.id?._serialized || 'N/A'}`);
      console.error(`   Media object:`, media ? 'exists but no data property' : 'null');
      console.error(`   ⚠️ This usually means the media has expired or been deleted from WhatsApp servers`);
      console.error(`   ⚠️ Videos older than a few days often become unavailable`);
      console.log('='.repeat(80) + '\n');
      
      return res.status(500).json({ 
        error: 'Failed to download media',
        details: 'Media download returned null - media may be expired, deleted, or unavailable. This often happens with videos that are too old or have been deleted from WhatsApp servers.',
        messageType: message.type,
        hasMedia: message.hasMedia,
        suggestion: 'Try downloading the media from WhatsApp directly, or ask the sender to resend it if possible.'
      });
    }
    
    console.log(`\n✅ [MEDIA DOWNLOAD] Media download successful!`);
    console.log(`   Filename: ${media.filename || 'unnamed'}`);
    console.log(`   Mimetype: ${media.mimetype}`);
    console.log(`   Size: ${media.data.length} bytes (${(media.data.length / 1024).toFixed(2)} KB)`);
    console.log(`   Size in MB: ${(media.data.length / (1024 * 1024)).toFixed(2)} MB`);
    
    // Check if it's a video and log additional info
    if (media.mimetype?.startsWith('video/')) {
      console.log(`   📹 Video file detected - size: ${(media.data.length / (1024 * 1024)).toFixed(2)} MB`);
    }
    
    // Check file size - warn if very large
    const sizeInMB = media.data.length / (1024 * 1024);
    if (sizeInMB > 20) {
      console.warn(`   ⚠️ Large file detected (${sizeInMB.toFixed(2)} MB) - may cause issues`);
    }
    
    console.log(`   Base64 data preview: ${media.data.substring(0, 100)}... (truncated)`);
    
    try {
      const response = {
        success: true,
        mediaUrl: `data:${media.mimetype};base64,${media.data}`,
        mediaFilename: media.filename || `media_${messageId}`,
        mediaMimetype: media.mimetype,
        mediaSize: media.data.length
      };
      
      // Calculate response size (base64 increases size by ~33%)
      const responseSize = JSON.stringify(response).length;
      const responseSizeMB = responseSize / (1024 * 1024);
      
      console.log(`\n✅ [MEDIA DOWNLOAD] Preparing response`);
      console.log(`   Response size: ${responseSize} bytes (${responseSizeMB.toFixed(2)} MB)`);
      
      if (responseSizeMB > 50) {
        console.error(`   ❌ Response size (${responseSizeMB.toFixed(2)} MB) exceeds safe limit`);
        return res.status(500).json({ 
          error: 'Media file too large to send',
          details: `File size (${sizeInMB.toFixed(2)} MB) exceeds response limit`,
          mediaSize: media.data.length,
          responseSize: responseSize
        });
      }
      
      console.log(`   ✅ Response size is acceptable, sending...`);
      console.log('='.repeat(80) + '\n');
      
      return res.json(response);
    } catch (responseError) {
      console.error(`\n❌ [MEDIA DOWNLOAD] Error sending response:`);
      console.error(`   Error message: ${responseError.message}`);
      console.error(`   Error stack: ${responseError.stack}`);
      console.error(`   Error name: ${responseError.name}`);
      console.error(`   Media size: ${media.data.length} bytes (${(media.data.length / (1024 * 1024)).toFixed(2)} MB)`);
      console.log('='.repeat(80) + '\n');
      
      return res.status(500).json({ 
        error: 'Failed to send media response',
        details: responseError.message,
        mediaSize: media.data.length,
        errorType: responseError.name
      });
    }
  } catch (error) {
    console.error('\n❌ [MEDIA DOWNLOAD] Unexpected error in download-media endpoint:');
    console.error(`   Error message: ${error.message}`);
    console.error(`   Error stack: ${error.stack}`);
    console.error(`   Error name: ${error.name}`);
    console.error(`   Error code: ${error.code || 'N/A'}`);
    console.error(`   Full error object:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    console.log('='.repeat(80) + '\n');
    
    // Make sure we always send details in the response
    const errorResponse = { 
      error: 'Failed to download media', 
      details: error.message || 'Unknown error occurred',
      errorType: error.name || 'Error',
      errorCode: error.code || undefined
    };
    
    console.error(`   Sending error response:`, JSON.stringify(errorResponse, null, 2));
    
    return res.status(500).json(errorResponse);
  }
});

// Google Sheets Group Management Endpoints

// Load customer groups from Google Sheets
app.get('/groups/load', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    
    if (forceRefresh) {
      console.log('🔄 Force refresh requested - loading from Google Sheets...');
    } else {
      console.log('📦 Loading groups (using cache if available)...');
    }
    
    customerGroups = await loadCustomerGroups(forceRefresh);
    
    const cacheInfo = customerGroupsCacheTime > 0 
      ? { cached: true, cacheAge: Math.round((Date.now() - customerGroupsCacheTime) / 1000) }
      : { cached: false };
    
    console.log('Groups loaded successfully. Total groups:', Object.keys(customerGroups).length);
    console.log('Loaded group names:', Object.keys(customerGroups));
    
    res.json({
      success: true,
      groups: customerGroups,
      totalGroups: Object.keys(customerGroups).length,
      message: forceRefresh 
        ? 'Customer groups refreshed from Google Sheets' 
        : 'Customer groups loaded (from cache)',
      cacheInfo: cacheInfo
    });
  } catch (error) {
    console.error('Error loading groups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load customer groups',
      details: error.message
    });
  }
});

// Get all customer groups
app.get('/groups', (req, res) => {
  try {
    const groups = Object.values(customerGroups).map(group => ({
      name: group.name,
      totalCustomers: group.totalCustomers,
      lastUpdated: group.lastUpdated,
      customers: group.customers.map(customer => ({
        phone: customer.phone,
        name: customer.name
      }))
    }));

    res.json({
      success: true,
      groups: groups,
      totalGroups: groups.length
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch groups',
      details: error.message
    });
  }
});

// Get specific group details
app.get('/groups/:groupName', (req, res) => {
  try {
    const groupName = req.params.groupName;
    const group = customerGroups[groupName];
    
    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }

    res.json({
      success: true,
      group: {
        name: group.name,
        totalCustomers: group.totalCustomers,
        lastUpdated: group.lastUpdated,
        customers: group.customers
      }
    });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch group',
      details: error.message
    });
  }
});

// Send message to a group
app.post('/groups/:groupName/send', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const result = await sendGroupMessageInternal(groupName, {
      message: req.body.message,
      mediaUrl: req.body.mediaUrl,
      mediaType: req.body.mediaType,
      mediaFilename: req.body.mediaFilename,
      hasMedia: req.body.hasMedia,
      selectedPhones: req.body.selectedPhones
    });

    if (result.status === 'validation_error') {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (result.status === 'not_found') {
      return res.status(404).json({ success: false, error: result.error });
    }

    if (result.status === 'client_not_ready') {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (result.status === 'error') {
      throw result.error || new Error('Failed to send group message');
    }

    return res.json({
      success: true,
      groupName,
      totalCustomers: result.targetedCustomers,
      successCount: result.successCount,
      errorCount: result.errorCount,
      results: result.results,
      message: `Message sent to ${result.successCount} out of ${result.targetedCustomers} selected customers`
    });
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send group message',
      details: error.message
    });
  }
});

// Schedule a group message
app.post('/groups/:groupName/schedule', async (req, res) => {
  try {
    const groupName = req.params.groupName;

    await ensureGroupData();
    const group = customerGroups[groupName];
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const validation = validateSchedulePayload(group, req.body, null, { requireFutureStart: true });
    if (validation.error) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const value = validation.value;

    const scheduleEntry = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groupName,
      message: value.message,
      mediaUrl: value.mediaUrl,
      mediaType: value.mediaType,
      mediaFilename: value.mediaFilename,
      hasMedia: value.hasMedia,
      targetScope: value.targetScope,
      selectedPhones: value.targetScope === 'selected' ? value.selectedPhones : [],
      recurrenceType: value.recurrenceType,
      weekdays: value.weekdays,
      monthlyDay: value.monthlyDay,
      startDate: value.startDate,
      startTime: value.startTime,
      endDate: value.endDate,
      endTime: value.endTime,
      timezone: value.timezone,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      lastRunAt: null,
      nextRun: null,
      status: 'active',
      lastError: null
    };

    const nextRun = computeNextRunForSchedule(scheduleEntry);
    if (!nextRun) {
      return res.status(400).json({
        success: false,
        error: 'Schedule configuration does not produce a run within the selected window'
      });
    }

    scheduleEntry.nextRun = nextRun.toISOString();

    scheduledMessages.push(scheduleEntry);
    saveScheduledMessages();

    console.log(`[SCHEDULE] Created schedule ${scheduleEntry.id} for group ${groupName}. Next run at ${scheduleEntry.nextRun}`);

    if (!scheduleChecker) {
      startScheduleChecker();
    }

    processScheduledMessages().catch(err => console.error('[SCHEDULE] Immediate scheduler run error:', err));

    res.json({
      success: true,
      scheduleId: scheduleEntry.id,
      nextRun: scheduleEntry.nextRun,
      status: scheduleEntry.status
    });
  } catch (error) {
    console.error('[SCHEDULE] Error creating schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create schedule',
      details: error.message
    });
  }
});

// Get scheduled messages (optional group filter)
app.get('/schedules', (req, res) => {
  try {
    const groupFilter = req.query.group || req.query.groupName || null;
    let schedules = scheduledMessages.slice();

    if (groupFilter) {
      schedules = schedules.filter(schedule => schedule.groupName === groupFilter);
    }

    schedules.sort((a, b) => {
      const aTime = a.nextRun ? new Date(a.nextRun).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.nextRun ? new Date(b.nextRun).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });

    res.json({ success: true, schedules });
  } catch (error) {
    console.error('[SCHEDULE] Error fetching schedules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch schedules',
      details: error.message
    });
  }
});

// Update an existing scheduled message
app.put('/schedules/:scheduleId', async (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const existingSchedule = scheduledMessages[scheduleIndex];
    await ensureGroupData();
    const group = customerGroups[existingSchedule.groupName];
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found for this schedule' });
    }

    const validation = validateSchedulePayload(group, req.body, existingSchedule, { requireFutureStart: false });
    if (validation.error) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const value = validation.value;

    existingSchedule.message = value.message;
    existingSchedule.mediaUrl = value.mediaUrl;
    existingSchedule.mediaType = value.mediaType;
    existingSchedule.mediaFilename = value.mediaFilename;
    existingSchedule.hasMedia = value.hasMedia;
    existingSchedule.targetScope = value.targetScope;
    existingSchedule.selectedPhones = value.targetScope === 'selected' ? value.selectedPhones : [];
    existingSchedule.recurrenceType = value.recurrenceType;
    existingSchedule.weekdays = value.weekdays;
    existingSchedule.monthlyDay = value.monthlyDay;
    existingSchedule.startDate = value.startDate;
    existingSchedule.startTime = value.startTime;
    existingSchedule.endDate = value.endDate;
    existingSchedule.endTime = value.endTime;
    existingSchedule.timezone = value.timezone;
    existingSchedule.status = 'active';
    existingSchedule.lastError = null;
    existingSchedule.updatedAt = new Date().toISOString();

    const nextRun = computeNextRunForSchedule(existingSchedule);
    if (!nextRun) {
      return res.status(400).json({
        success: false,
        error: 'Schedule configuration does not produce a run within the selected window'
      });
    }

    existingSchedule.nextRun = nextRun.toISOString();

    scheduledMessages[scheduleIndex] = existingSchedule;
    saveScheduledMessages();
    processScheduledMessages().catch(err => console.error('[SCHEDULE] Immediate scheduler run error:', err));

    res.json({
      success: true,
      schedule: existingSchedule,
      nextRun: existingSchedule.nextRun
    });
  } catch (error) {
    console.error('[SCHEDULE] Error updating schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update schedule',
      details: error.message
    });
  }
});

// Delete a scheduled message
app.delete('/schedules/:scheduleId', (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    scheduledMessages.splice(scheduleIndex, 1);
    saveScheduledMessages();

    res.json({ success: true });
    processScheduledMessages().catch(err => console.error('[SCHEDULE] Immediate scheduler run error:', err));
  } catch (error) {
    console.error('[SCHEDULE] Error deleting schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete schedule',
      details: error.message
    });
  }
});

// Update attendance for a customer
app.post('/groups/:groupName/attendance', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { customerPhone, status = 'present', month, message = '', messageTimestamp = null } = req.body;
    
    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Customer phone number is required'
      });
    }

    // Use provided month or default to current month (YYYY-MM format)
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    
    const success = await updateAttendance(groupName, customerPhone, status, targetMonth, message, messageTimestamp);
    
    if (success) {
      res.json({
        success: true,
        message: `Attendance updated for customer ${customerPhone}`,
        attendance: attendanceData[groupName]?.[customerPhone]
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Customer not found in group'
      });
    }
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update attendance',
      details: error.message
    });
  }
});

// Confirm code for a customer (logs to CodeMonitor sheet)
app.post('/groups/:groupName/code-confirm', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { customerPhone, message = '', messageTimestamp = null, code = '' } = req.body || {};

    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Customer phone number is required'
      });
    }

    if (!code || code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Code is required'
      });
    }

    const result = await recordCodeConfirmation(groupName, customerPhone, message, messageTimestamp, code);

    if (result.success) {
      res.json({
        success: true,
        message: `Code confirmation logged for ${customerPhone}`,
        record: result.record
      });
    } else {
      const statusCode = result.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        error: result.error || 'Failed to confirm code'
      });
    }
  } catch (error) {
    console.error('Error confirming code:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm code',
      details: error.message
    });
  }
});

// Get list of codes from Code Monitor sheet
app.get('/api/codes/list', async (req, res) => {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      return res.status(500).json({
        success: false,
        error: 'Google Sheets not initialized',
        codes: []
      });
    }

    // Get all sheet names
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });
    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);

    // Try to find "Code Monitor" or "CodeMonitor" sheet
    let codeSheetName = null;
    if (sheetNames.includes('Code Monitor')) {
      codeSheetName = 'Code Monitor';
    } else if (sheetNames.includes('CodeMonitor')) {
      codeSheetName = 'CodeMonitor';
    }

    if (!codeSheetName) {
      // Sheet doesn't exist, return empty list
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet not found'
      });
    }

    // Read the sheet data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: `${codeSheetName}!A:Z`
    });

    const rows = response.data.values || [];
    console.log(`[CODES] Retrieved ${rows.length} rows from sheet "${codeSheetName}"`);
    if (rows.length === 0) {
      console.log(`[CODES] Sheet is empty`);
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet is empty'
      });
    }
    
    if (rows.length === 1) {
      console.log(`[CODES] Sheet only has header row, no data rows`);
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet has no data rows'
      });
    }

    // Find the "Code" column header (case-insensitive)
    const headerRow = rows[0];
    console.log(`[CODES] Header row:`, headerRow);
    let codeColumnIndex = -1;
    for (let i = 0; i < headerRow.length; i++) {
      const headerValue = headerRow[i];
      if (headerValue) {
        const headerLower = headerValue.toString().toLowerCase().trim();
        console.log(`[CODES] Checking header[${i}]: "${headerValue}" -> "${headerLower}"`);
        if (headerLower === 'code') {
          codeColumnIndex = i;
          console.log(`[CODES] Found "Code" column at index ${i}`);
          break;
        }
      }
    }

    if (codeColumnIndex === -1) {
      // Code column not found
      console.log(`[CODES] Code column not found. Available headers:`, headerRow);
      return res.json({
        success: true,
        codes: [],
        message: 'Code column not found in Code Monitor sheet',
        availableHeaders: headerRow
      });
    }

    // Extract unique codes from the column (skip header row)
    const codesSet = new Set();
    console.log(`[CODES] Found Code column at index ${codeColumnIndex}`);
    console.log(`[CODES] Total rows in sheet: ${rows.length}`);
    console.log(`[CODES] Sheet name: ${codeSheetName}`);
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) {
        console.log(`[CODES] Row ${i} is empty, skipping`);
        continue;
      }
      if (row.length <= codeColumnIndex) {
        console.log(`[CODES] Row ${i} has only ${row.length} columns, need index ${codeColumnIndex}, skipping`);
        continue; // Skip rows that don't have enough columns
      }
      const codeValue = row[codeColumnIndex];
      if (codeValue !== undefined && codeValue !== null && codeValue.toString().trim() !== '') {
        const trimmedCode = codeValue.toString().trim();
        codesSet.add(trimmedCode);
        console.log(`[CODES] Row ${i}: Found code "${trimmedCode}"`);
      } else {
        console.log(`[CODES] Row ${i}: Code value is empty or null (value: ${codeValue})`);
      }
    }

    // Convert to sorted array
    const codes = Array.from(codesSet).sort();
    console.log(`[CODES] Returning ${codes.length} unique codes:`, codes);

    res.json({
      success: true,
      codes: codes
    });
  } catch (error) {
    console.error('Error fetching codes from Code Monitor:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch codes',
      details: error.message,
      codes: []
    });
  }
});

// Get attendance data for a group
app.get('/groups/:groupName/attendance', (req, res) => {
  try {
    const groupName = req.params.groupName;
    const groupAttendance = attendanceData[groupName] || {};
    
    res.json({
      success: true,
      groupName: groupName,
      attendance: groupAttendance,
      totalMarked: Object.keys(groupAttendance).length
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch attendance',
      details: error.message
    });
  }
});

// Get all customers from all groups
app.get('/customers/list', async (req, res) => {
  try {
    // Load groups from Google Sheets if not loaded
    if (Object.keys(customerGroups).length === 0) {
      await loadCustomerGroups();
    }
    
    // Collect all customers with their group names
    const allCustomers = [];
    
    Object.keys(customerGroups).forEach(groupName => {
      const group = customerGroups[groupName];
      if (group.customers && Array.isArray(group.customers)) {
        group.customers.forEach(customer => {
          allCustomers.push({
            ...customer,
            groupName: groupName
          });
        });
      }
    });
    
    res.json({
      success: true,
      totalCustomers: allCustomers.length,
      totalGroups: Object.keys(customerGroups).length,
      customers: allCustomers
    });
  } catch (error) {
    console.error('Error fetching customer list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customer list',
      details: error.message
    });
  }
});

// Get absentees for a group
app.get('/groups/:groupName/absentees', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const group = customerGroups[groupName];
    
    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }
    
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dayOfMonth = new Date().getDate().toString(); // e.g., "27"
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    
    console.log(`[DEBUG] Checking absentees for group: ${groupName}`);
    console.log(`[DEBUG] Today: ${today}, Day: ${dayOfMonth}, Month: ${currentMonth}`);
    console.log(`[DEBUG] Total customers in group: ${group.customers.length}`);
    
    // Read attendance from Google Sheet
    const sheets = await initializeGoogleSheets();
    let sheetAttendanceData = {};
    
    if (sheets) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!A:Z`
        });
        
        const rows = response.data.values;
        if (rows && rows.length > 1) {
          const headers = rows[0];
          const phoneCol = headers.findIndex(h => 
            h && (h.toLowerCase().includes('phone') || 
            h.toLowerCase().includes('number') ||
            h.toLowerCase().includes('whatsapp'))
          );
          
          // Find the column for today's date
          const dayCol = headers.findIndex(h => h && h.toString().trim() === dayOfMonth);
          
          if (phoneCol !== -1 && dayCol !== -1) {
            // Build attendance map from sheet
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              const phone = row[phoneCol] ? row[phoneCol].toString().replace(/\D/g, '') : '';
              const attendance = row[dayCol];
              
              if (phone && attendance && (attendance === 'P' || attendance === 'p' || attendance === 'Present')) {
                sheetAttendanceData[phone] = true;
              }
            }
          }
        }
        console.log(`[DEBUG] Attendance from sheet: ${Object.keys(sheetAttendanceData).length} present`);
      } catch (error) {
        console.error('Error reading attendance from sheet:', error);
      }
    }
    
    // Also check in-memory attendance (for newly marked attendance in this session)
    const groupAttendance = attendanceData[groupName] || {};
    
    const presentCustomers = new Set();
    const absentCustomers = [];
    
    // Check each customer's attendance
    group.customers.forEach(customer => {
      // Check Google Sheet first, then in-memory
      const sheetPresent = sheetAttendanceData[customer.phone];
      const customerAttendance = groupAttendance[customer.phone];
      
      const inMemoryPresent = customerAttendance && 
                             customerAttendance[currentMonth] && 
                             customerAttendance[currentMonth].includes(today);
      
      const isPresent = sheetPresent || inMemoryPresent;
      
      console.log(`[DEBUG] Customer: ${customer.name} (${customer.phone}) - Sheet: ${sheetPresent || false}, Memory: ${inMemoryPresent || false}`);
      
      if (isPresent) {
        presentCustomers.add(customer.phone);
      } else {
        absentCustomers.push({
          name: customer.name,
          phone: customer.phone
        });
      }
    });
    
    res.json({
      success: true,
      groupName: groupName,
      totalCustomers: group.totalCustomers,
      presentCount: presentCustomers.size,
      absentCount: absentCustomers.length,
      absentCustomers: absentCustomers
    });
  } catch (error) {
    console.error('Error fetching absentees:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch absentees',
      details: error.message
    });
  }
});

// Send follow-up message to absentees
app.post('/groups/:groupName/followup', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { message, selectedPhones } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }
    
    const group = customerGroups[groupName];
    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }
    
    if (!isClientReady) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp client not ready'
      });
    }
    
    // Get absentees for today - check both Google Sheets and in-memory
    const today = new Date().toISOString().slice(0, 10);
    const dayOfMonth = new Date().getDate().toString();
    const currentMonth = new Date().toISOString().slice(0, 7);
    
    // Read attendance from Google Sheet
    const sheets = await initializeGoogleSheets();
    let sheetAttendanceData = {};
    
    if (sheets) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!A:Z`
        });
        
        const rows = response.data.values;
        if (rows && rows.length > 1) {
          const headers = rows[0];
          const phoneCol = headers.findIndex(h => 
            h && (h.toLowerCase().includes('phone') || 
            h.toLowerCase().includes('number') ||
            h.toLowerCase().includes('whatsapp'))
          );
          const dayCol = headers.findIndex(h => h && h.toString().trim() === dayOfMonth);
          
          if (phoneCol !== -1 && dayCol !== -1) {
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              const phone = row[phoneCol] ? row[phoneCol].toString().replace(/\D/g, '') : '';
              const attendance = row[dayCol];
              if (phone && attendance && (attendance === 'P' || attendance === 'p' || attendance === 'Present')) {
                sheetAttendanceData[phone] = true;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error reading attendance from sheet:', error);
      }
    }
    
    // Also check in-memory
    const groupAttendance = attendanceData[groupName] || {};
    
    // Get all absent customers
    let absentCustomers = group.customers.filter(customer => {
      const sheetPresent = sheetAttendanceData[customer.phone];
      const customerAttendance = groupAttendance[customer.phone];
      const inMemoryPresent = customerAttendance && 
                             customerAttendance[currentMonth] && 
                             customerAttendance[currentMonth].includes(today);
      
      return !(sheetPresent || inMemoryPresent);
    });
    
    // If specific phones are selected, filter to only those
    if (selectedPhones && selectedPhones.length > 0) {
      const selectedPhonesClean = selectedPhones.map(phone => phone.replace(/\D/g, ''));
      absentCustomers = absentCustomers.filter(customer => 
        selectedPhonesClean.includes(customer.phone.replace(/\D/g, ''))
      );
    }
    
    if (absentCustomers.length === 0) {
      return res.json({
        success: true,
        message: 'No absentees found',
        successCount: 0,
        errorCount: 0
      });
    }
    
    // Send message to each selected absent customer
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    
    for (const customer of absentCustomers) {
      try {
        const chatId = `${customer.phone}@c.us`;
        const chat = await client.getChatById(chatId);
        await chat.sendMessage(message);
        
        successCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'sent'
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: error.message
        });
        console.error(`Failed to send follow-up to ${customer.name} (${customer.phone}):`, error);
      }
    }
    
    res.json({
      success: true,
      groupName: groupName,
      totalAbsentees: absentCustomers.length,
      successCount: successCount,
      errorCount: errorCount,
      results: results,
      message: `Follow-up sent to ${successCount} out of ${absentCustomers.length} absentees`
    });
  } catch (error) {
    console.error('Error sending follow-up:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send follow-up',
      details: error.message
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current status
  socket.emit('clientStatus', { 
    isReady: isClientReady,
    targetPhones: targetPhoneNumbers 
  });
  
  // If QR code is available, send it
  if (qrCodeData) {
    QRCode.toDataURL(qrCodeData, (err, url) => {
      if (!err) {
        socket.emit('qrCode', { qrData: qrCodeData, qrImage: url });
      }
    });
  }
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Google Sheets API functions
// Helper: Convert zero-based column index to Google Sheets column letters (A, B, ... AA)
function getColumnLetter(index) {
  let result = '';
  let num = index;
  while (num >= 0) {
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26) - 1;
  }
  return result;
}

// Write attendance record to Attendance sheet
async function writeAttendanceToSheet(groupName, memberName, memberPhone, message = '', messageTimestamp = null) {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      console.error('Google Sheets not initialized');
      return false;
    }

    // Use message timestamp if provided, otherwise use current time
    // messageTimestamp is in Unix seconds, convert to milliseconds for Date
    const timestamp = messageTimestamp ? new Date(messageTimestamp * 1000) : new Date();
    
    // Get timezone information
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneOffset = timestamp.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
    const offsetMinutes = Math.abs(timezoneOffset) % 60;
    const offsetSign = timezoneOffset <= 0 ? '+' : '-';
    const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
    
    // Use local time methods instead of toISOString() to avoid UTC conversion
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0'); // getMonth() returns 0-11
    const day = String(timestamp.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`; // YYYY-MM-DD format in local time
    const time = timestamp.toTimeString().split(' ')[0]; // HH:MM:SS format (already local time)
    
    // Log timezone information
    if (messageTimestamp) {
      console.log(`[ATTENDANCE] Using message timestamp: ${date} ${time} (from message)`);
      console.log(`[ATTENDANCE] Timezone: ${timezone} (UTC${offsetString})`);
      console.log(`[ATTENDANCE] Original message timestamp (Unix): ${messageTimestamp}`);
      console.log(`[ATTENDANCE] Converted to local time: ${timestamp.toLocaleString('en-US', { timeZone: timezone })}`);
    } else {
      console.log(`[ATTENDANCE] Using current timestamp: ${date} ${time} (current time)`);
      console.log(`[ATTENDANCE] Timezone: ${timezone} (UTC${offsetString})`);
      console.log(`[ATTENDANCE] Current local time: ${timestamp.toLocaleString('en-US', { timeZone: timezone })}`);
    }

    // Prepare the row data: Date, Time, Group, Member, Message, Timezone
    const rowData = [date, time, groupName, memberName || memberPhone, message || '', `${timezone} (UTC${offsetString})`];

    // Check if Attendance sheet exists, create if it doesn't
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
      });

      const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
      const attendanceSheetExists = sheetNames.includes('Attendance');

      if (!attendanceSheetExists) {
        // Create the Attendance sheet with headers
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: 'Attendance',
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 6
                  }
                }
              }
            }]
          }
        });

        // Add headers (with Timezone column)
        await sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: 'Attendance!A1:F1',
          valueInputOption: 'RAW',
          resource: {
            values: [['Date', 'Time', 'Group', 'Member', 'Message', 'Timezone']]
          }
        });

        console.log('Created Attendance sheet with headers');
      }
    } catch (error) {
      console.error('Error checking/creating Attendance sheet:', error);
      return false;
    }

    // Append the row to the Attendance sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: 'Attendance!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log(`✅ Attendance record written: ${date} ${time} (${timezone} UTC${offsetString}) - ${groupName} - ${memberName}`);
    return true;
  } catch (error) {
    console.error('Error writing attendance to sheet:', error);
    return false;
  }
}

async function recordCodeConfirmation(groupName, customerPhone, message = '', messageTimestamp = null, code = '') {
  try {
    await ensureGroupData();
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      return { success: false, error: 'Google Sheets not initialized', statusCode: 500 };
    }

    const group = customerGroups[groupName];
    if (!group) {
      return { success: false, error: 'Group not found', statusCode: 404 };
    }

    const cleanedPhone = customerPhone.replace(/\D/g, '');
    const customer = group.customers?.find(c => c.phone.replace(/\D/g, '') === cleanedPhone);
    const memberName = customer?.name || cleanedPhone;
    const memberPhone = customer?.phone || customerPhone;

    const timestampValue = messageTimestamp ? Number(messageTimestamp) : null;
    let timestamp = timestampValue ? new Date(timestampValue * 1000) : new Date();
    if (Number.isNaN(timestamp.getTime())) {
      console.warn('[CODE] Invalid timestamp provided, using current time');
      timestamp = new Date();
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneOffset = timestamp.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
    const offsetMinutes = Math.abs(timezoneOffset) % 60;
    const offsetSign = timezoneOffset <= 0 ? '+' : '-';
    const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    const time = timestamp.toTimeString().split(' ')[0];

    // Prepare row data: Date, Time, Group, Member, Phone, Message, Timezone, Code
    const rowData = [
      date,
      time,
      groupName,
      memberName,
      memberPhone,
      message || '',
      `${timezone} (UTC${offsetString})`,
      code || ''
    ];

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });
    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
    const codeSheetExists = sheetNames.includes('CodeMonitor');

    if (!codeSheetExists) {
      // Create CodeMonitor sheet with Code column (8 columns total)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: 'CodeMonitor',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 8
                }
              }
            }
          }]
        }
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
        range: 'CodeMonitor!A1:H1',
        valueInputOption: 'RAW',
        resource: {
          values: [[
            'Date',
            'Time',
            'Group',
            'Member',
            'Phone',
            'Message',
            'Timezone',
            'Code'
          ]]
        }
      });

      console.log('[CODE] Created CodeMonitor sheet with headers (including Code column)');
    } else {
      // Check if Code column exists, if not add it
      try {
        const headerResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: 'CodeMonitor!A1:H1'
        });
        
        const headers = headerResponse.data.values?.[0] || [];
        const hasCodeColumn = headers.some(h => h && h.toString().toLowerCase().trim() === 'code');
        
        if (!hasCodeColumn) {
          // Code column doesn't exist, update headers to include it
          // Find the index after Timezone (Code should be after Timezone)
          const timezoneIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'timezone');
          const insertIndex = timezoneIndex !== -1 ? timezoneIndex + 1 : headers.length;
          
          // Update headers to include Code column after Timezone
          const newHeaders = [...headers];
          newHeaders.splice(insertIndex, 0, 'Code');
          
          await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
            range: `CodeMonitor!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
            valueInputOption: 'RAW',
            resource: {
              values: [newHeaders]
            }
          });
          
          console.log('[CODE] Added Code column to existing CodeMonitor sheet (after Timezone)');
        } else {
          // Code column exists, check if Timezone is before it
          const codeIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'code');
          const timezoneIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'timezone');
          
          if (timezoneIndex !== -1 && codeIndex !== -1 && timezoneIndex > codeIndex) {
            // Timezone is after Code, need to reorder
            const newHeaders = [...headers];
            const timezone = newHeaders.splice(timezoneIndex, 1)[0];
            // Insert Timezone before Code
            newHeaders.splice(codeIndex, 0, timezone);
            
            await sheets.spreadsheets.values.update({
              spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
              range: `CodeMonitor!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
              valueInputOption: 'RAW',
              resource: {
                values: [newHeaders]
              }
            });
            
            console.log('[CODE] Reordered columns: Timezone is now before Code');
          }
        }
      } catch (error) {
        console.warn('[CODE] Could not check/update CodeMonitor headers:', error.message);
        // Continue anyway, will try to append with Code column
      }
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: 'CodeMonitor!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log(`[CODE] Logged confirmation for ${memberName} (${memberPhone}) in CodeMonitor`);

    return { success: true, record: rowData };
  } catch (error) {
    console.error('Error recording code confirmation:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

async function initializeGoogleSheets() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_SHEETS_CONFIG.credentials,
      scopes: GOOGLE_SHEETS_CONFIG.scopes
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    return sheets;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    return null;
  }
}

async function loadCustomerGroups(forceRefresh = false) {
  try {
    // Return cached data if available and not forcing refresh
    if (!forceRefresh && customerGroupsCache && customerGroupsCacheTime > 0) {
      const cacheAge = Date.now() - customerGroupsCacheTime;
      console.log(`📦 Returning cached customer groups (cached ${Math.round(cacheAge / 1000)}s ago)`);
      return customerGroupsCache;
    }

    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      console.log('Google Sheets not configured');
      // Return cached data if available, even if Sheets not configured
      if (customerGroupsCache) {
        console.log('⚠️ Google Sheets not configured, returning cached data');
        return customerGroupsCache;
      }
      return {};
    }

    console.log('🔄 Loading customer groups from Google Sheets...');
    const startTime = Date.now();

    // Get all sheet names
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });

    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
    console.log('Available sheets:', sheetNames);

    const groups = {};

    // Exclude "Master" sheet to prevent accidental mass messaging
    const excludedSheets = ['Master'];

    for (const sheetName of sheetNames) {
      // Skip excluded sheets
      if (excludedSheets.includes(sheetName)) {
        console.log(`Skipping excluded sheet: ${sheetName}`);
        continue;
      }

      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${sheetName}!A:Z`
        });

        const rows = response.data.values;
        if (!rows || rows.length < 2) continue;

        const headers = rows[0];
        const dataRows = rows.slice(1);

        // Find phone number and name columns
        const phoneCol = headers.findIndex(h => 
          h && h.toLowerCase().includes('phone') || 
          h && h.toLowerCase().includes('number') ||
          h && h.toLowerCase().includes('whatsapp')
        );
        const nameCol = headers.findIndex(h => 
          h && h.toLowerCase().includes('name') || 
          h && h.toLowerCase().includes('customer')
        );

        if (phoneCol === -1) continue;

        const customers = dataRows.map(row => {
          const phone = row[phoneCol] ? row[phoneCol].toString().trim() : '';
          const name = nameCol !== -1 && row[nameCol] ? row[nameCol].toString().trim() : '';
          
          // Check if it's already a group ID or contact ID with @g.us or @c.us
          if (phone.includes('@g.us') || phone.includes('@c.us')) {
            // Already in correct format - use as is
            return {
              phone: phone,
              name: name || phone,
              originalPhone: phone,
              isGroup: phone.includes('@g.us')
            };
          }
          
          // Auto-detect group IDs: Numbers 15-20 digits long starting with 120 are group IDs
          const digitsOnly = phone.replace(/\D/g, ''); // Remove non-digits
          if (digitsOnly.length >= 15 && digitsOnly.length <= 20 && digitsOnly.startsWith('120')) {
            // This looks like a group ID - add @g.us suffix
            console.log(`Auto-detected group ID: ${digitsOnly}`);
            return {
              phone: `${digitsOnly}@g.us`,
              name: name || phone,
              originalPhone: phone,
              isGroup: true
            };
          }
          
          // Format phone number for regular contacts
          let formattedPhone = digitsOnly;
          if (formattedPhone && !formattedPhone.startsWith('91')) {
            formattedPhone = '91' + formattedPhone;
          }
          
          return {
            phone: formattedPhone,
            name: name || phone,
            originalPhone: phone,
            isGroup: false
          };
        }).filter(customer => customer.phone && (customer.phone.length >= 10 || customer.phone.includes('@g.us')));

        groups[sheetName] = {
          name: sheetName,
          customers: customers,
          totalCustomers: customers.length,
          lastUpdated: new Date().toISOString()
        };

        console.log(`Loaded ${customers.length} customers from sheet: ${sheetName}`);
      } catch (error) {
        console.error(`Error loading sheet ${sheetName}:`, error);
      }
    }

    const loadTime = Date.now() - startTime;
    console.log(`✅ Loaded ${Object.keys(groups).length} groups in ${loadTime}ms`);

    // Update cache
    customerGroupsCache = groups;
    customerGroupsCacheTime = Date.now();
    customerGroups = groups; // Also update the global variable

    return groups;
  } catch (error) {
    console.error('Error loading customer groups:', error);
    // Return cached data if available, even on error
    if (customerGroupsCache) {
      console.log('⚠️ Error loading groups, returning cached data');
      return customerGroupsCache;
    }
    return {};
  }
}

async function ensureGroupData() {
  // Use cache if available, otherwise load
  if (customerGroupsCache && customerGroupsCacheTime > 0) {
    customerGroups = customerGroupsCache;
    return;
  }
  
  if (customerGroups && Object.keys(customerGroups).length > 0) {
    return;
  }
  
  console.log('[SCHEDULE] Customer group cache empty. Loading from Google Sheets...');
  customerGroups = await loadCustomerGroups(false); // Don't force refresh
}

function validateSchedulePayload(group, payload = {}, existingSchedule = null, options = {}) {
  const requireFutureStart = options.requireFutureStart ?? false;

  if (!group || !Array.isArray(group.customers)) {
    return { error: 'Group data unavailable' };
  }

  const timezone = existingSchedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const message = typeof payload.message === 'string'
    ? payload.message
    : (payload.message != null ? String(payload.message) : (existingSchedule?.message || ''));

  const mediaUrl = typeof payload.mediaUrl === 'string'
    ? payload.mediaUrl
    : (existingSchedule?.mediaUrl || '');

  if (!message && !mediaUrl) {
    return { error: 'Message or media is required' };
  }

  const mediaType = payload.mediaType || existingSchedule?.mediaType || null;
  const mediaFilename = payload.mediaFilename || existingSchedule?.mediaFilename || null;
  const hasMedia = typeof payload.hasMedia === 'boolean' ? payload.hasMedia : !!mediaUrl;

  const targetScope = payload.targetScope === 'all'
    ? 'all'
    : 'selected';

  let selectedPhones = [];
  if (targetScope === 'selected') {
    const providedPhones = Array.isArray(payload.selectedPhones) && payload.selectedPhones.length > 0
      ? payload.selectedPhones
      : (existingSchedule?.selectedPhones || []);

    if (!providedPhones.length) {
      return { error: 'Select at least one recipient to schedule' };
    }

    const validPhones = new Set(group.customers.map(customer => customer.phone));
    selectedPhones = providedPhones.map(phone => phone.toString());
    const invalidPhones = selectedPhones.filter(phone => !validPhones.has(phone));

    if (invalidPhones.length > 0) {
      return { error: `Invalid recipients: ${invalidPhones.join(', ')}` };
    }
  }

  const scheduleData = payload.schedule || {};
  const startDate = scheduleData.startDate || existingSchedule?.startDate;
  const startTime = scheduleData.startTime || existingSchedule?.startTime;
  const endDate = scheduleData.endDate || existingSchedule?.endDate;
  const endTime = scheduleData.endTime || existingSchedule?.endTime;

  if (!startDate || !startTime || !endDate || !endTime) {
    return { error: 'Start and end date/time are required' };
  }

  const startDateTime = combineScheduleDateTime(startDate, startTime);
  const endDateTime = combineScheduleDateTime(endDate, endTime);

  if (!startDateTime || Number.isNaN(startDateTime.getTime())) {
    return { error: 'Invalid start date/time' };
  }
  if (!endDateTime || Number.isNaN(endDateTime.getTime())) {
    return { error: 'Invalid end date/time' };
  }

  if (requireFutureStart && startDateTime <= new Date()) {
    return { error: 'Start time must be in the future' };
  }

  const recurrenceType = (scheduleData.recurrenceType || existingSchedule?.recurrenceType || 'daily').toLowerCase();
  const allowedRecurrence = ['once', 'daily', 'weekly', 'monthly'];
  if (!allowedRecurrence.includes(recurrenceType)) {
    return { error: 'Invalid recurrence type' };
  }

  if (recurrenceType === 'once') {
    if (endDateTime < startDateTime) {
      return { error: 'End time cannot be before the start time for one-time schedules' };
    }
  } else if (endDateTime <= startDateTime) {
    return { error: 'End time must be after the start time' };
  }

  let weekdays = [];
  let monthlyDay = null;

  if (recurrenceType === 'weekly') {
    const providedWeekdays = Array.isArray(scheduleData.weekdays)
      ? scheduleData.weekdays
      : (existingSchedule?.weekdays || []);
    weekdays = providedWeekdays
      .map(value => Number(value))
      .filter(value => !Number.isNaN(value) && value >= 0 && value <= 6);

    if (!weekdays.length) {
      return { error: 'Select at least one weekday for weekly schedules' };
    }
  }

  if (recurrenceType === 'monthly') {
    const providedDay = scheduleData.monthlyDay ?? existingSchedule?.monthlyDay ?? startDateTime.getDate();
    monthlyDay = parseInt(providedDay, 10);
    if (Number.isNaN(monthlyDay) || monthlyDay < 1 || monthlyDay > 31) {
      return { error: 'Invalid monthly day (must be between 1 and 31)' };
    }
  }

  return {
    value: {
      message,
      mediaUrl,
      mediaType,
      mediaFilename,
      hasMedia,
      targetScope,
      selectedPhones,
      startDate,
      startTime,
      endDate,
      endTime,
      recurrenceType,
      weekdays,
      monthlyDay,
      timezone,
      startDateTime,
      endDateTime
    }
  };
}

// Function to replace placeholders in message text
function replaceMessagePlaceholders(message, customer, sendDate = new Date()) {
  if (!message || typeof message !== 'string') {
    return message;
  }
  
  let replacedMessage = message;
  
  // Replace <day of the week>
  const dayOfWeek = sendDate.toLocaleDateString('en-US', { weekday: 'long' });
  replacedMessage = replacedMessage.replace(/<day of the week>/gi, dayOfWeek);
  
  // Replace <date of month>
  const dateOfMonth = sendDate.getDate().toString();
  replacedMessage = replacedMessage.replace(/<date of month>/gi, dateOfMonth);
  
  // Replace <customer name>
  if (customer && customer.name) {
    replacedMessage = replacedMessage.replace(/<customer name>/gi, customer.name);
  }
  
  return replacedMessage;
}

async function sendGroupMessageInternal(groupName, options = {}) {
  try {
    const {
      message,
      mediaUrl,
      mediaType,
      mediaFilename,
      hasMedia,
      selectedPhones
    } = options;

    if (!message && !mediaUrl) {
      return {
        status: 'validation_error',
        error: 'Message content is required'
      };
    }

    await ensureGroupData();

    const group = customerGroups[groupName];
    if (!group) {
      return {
        status: 'not_found',
        error: 'Group not found'
      };
    }

    if (!isClientReady) {
      return {
        status: 'client_not_ready',
        error: 'WhatsApp client not ready'
      };
    }

    console.log('Forward request received:', {
      groupName,
      hasMessage: !!message,
      hasMedia: hasMedia,
      mediaType,
      mediaFilename,
      mediaUrlLength: mediaUrl ? mediaUrl.length : 0,
      selectedPhonesCount: selectedPhones ? selectedPhones.length : 'all'
    });

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    let customersToMessage = group.customers;
    if (selectedPhones && Array.isArray(selectedPhones) && selectedPhones.length > 0) {
      customersToMessage = group.customers.filter(customer =>
        selectedPhones.includes(customer.phone)
      );
      console.log(`Filtering to ${customersToMessage.length} selected customers out of ${group.customers.length} total`);
    }

    for (const customer of customersToMessage) {
      try {
        let chatId;
        if (customer.phone.includes('@g.us') || customer.phone.includes('@c.us')) {
          chatId = customer.phone;
        } else {
          chatId = `${customer.phone}@c.us`;
        }

        console.log(`Getting chat for ID: ${chatId}, isGroup: ${customer.phone.includes('@g.us')}`);
        const chat = await client.getChatById(chatId);

        // Replace placeholders in message for this customer
        const sendDate = new Date();
        const personalizedMessage = message ? replaceMessagePlaceholders(message, customer, sendDate) : message;
        const personalizedMediaCaption = message ? replaceMessagePlaceholders(message, customer, sendDate) : message;

        if (hasMedia && mediaUrl && mediaType) {
          console.log(`Sending media to ${customer.phone}:`, {
            mediaType,
            mediaFilename,
            isBase64: mediaUrl.startsWith('data:'),
            mediaSize: mediaUrl.length
          });

          if (mediaUrl.startsWith('data:')) {
            const base64Data = mediaUrl.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');

            const tempDir = path.join(__dirname, 'temp');

            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }

            const tempFilePath = path.join(tempDir, `${Date.now()}_${mediaFilename || 'media'}`);
            fs.writeFileSync(tempFilePath, buffer);

            try {
              const mediaMessage = new MessageMedia(mediaType, base64Data);
              await chat.sendMessage(mediaMessage, { caption: personalizedMediaCaption });
            } catch (error) {
              console.error('Error sending media message:', error);
              await chat.sendMessage(personalizedMessage || '');
            } finally {
              if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
              }
            }
          } else {
            await chat.sendMessage(mediaUrl, { caption: personalizedMediaCaption });
          }
        } else if (personalizedMessage) {
          await chat.sendMessage(personalizedMessage);
        } else if (mediaUrl) {
          await chat.sendMessage(mediaUrl);
        }

        successCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'sent'
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: error.message
        });
        console.error(`Failed to send message to ${customer.name} (${customer.phone}):`, error);
      }
    }

    return {
      status: 'sent',
      successCount,
      errorCount,
      totalCustomers: group.customers.length,
      targetedCustomers: customersToMessage.length,
      results
    };
  } catch (error) {
    console.error('Error sending group message (internal):', error);
    return {
      status: 'error',
      error
    };
  }
}

function combineScheduleDateTime(dateStr, timeStr) {
  if (!dateStr) {
    return null;
  }

  let timeComponent = timeStr || '00:00';
  if (timeComponent.length === 5) {
    timeComponent += ':00';
  }

  const date = new Date(`${dateStr}T${timeComponent}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDaysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function computeNextRunForSchedule(schedule, referenceDate = null) {
  const startDateTime = combineScheduleDateTime(schedule.startDate, schedule.startTime);
  const endDateTime = combineScheduleDateTime(schedule.endDate, schedule.endTime);

  if (!startDateTime) {
    return null;
  }

  const now = referenceDate ? new Date(referenceDate) : new Date();
  const startHour = startDateTime.getHours();
  const startMinute = startDateTime.getMinutes();
  const recurrenceType = (schedule.recurrenceType || 'daily').toLowerCase();
  let candidate = null;

  if (recurrenceType === 'once') {
    candidate = new Date(startDateTime);
    if (candidate < now) {
      return null;
    }
  } else if (recurrenceType === 'daily') {
    candidate = new Date(startDateTime);
    if (candidate < now) {
      const dayMs = 24 * 60 * 60 * 1000;
      const diffMs = now.getTime() - candidate.getTime();
      const daysAhead = Math.ceil(diffMs / dayMs);
      candidate = new Date(candidate.getTime() + daysAhead * dayMs);
    }
  } else if (recurrenceType === 'weekly') {
    const weekdays = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
      ? schedule.weekdays.map(Number).filter(num => !Number.isNaN(num) && num >= 0 && num <= 6)
      : [startDateTime.getDay()];

    candidate = new Date(Math.max(startDateTime.getTime(), now.getTime()));
    candidate.setHours(startHour, startMinute, 0, 0);
    if (candidate < now) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(startHour, startMinute, 0, 0);
    }

    let attempts = 0;
    while (attempts < 14) {
      if (candidate >= startDateTime && weekdays.includes(candidate.getDay())) {
        break;
      }
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(startHour, startMinute, 0, 0);
      attempts++;
    }

    if (!weekdays.includes(candidate.getDay())) {
      return null;
    }
  } else if (recurrenceType === 'monthly') {
    const desiredDay = schedule.monthlyDay ? parseInt(schedule.monthlyDay, 10) : startDateTime.getDate();
    const validDay = Number.isNaN(desiredDay) ? startDateTime.getDate() : Math.min(Math.max(desiredDay, 1), 31);

    const adjustToMonthlyDay = (date) => {
      const daysInMonth = getDaysInMonth(date.getFullYear(), date.getMonth());
      const day = Math.min(validDay, daysInMonth);
      const adjusted = new Date(date);
      adjusted.setDate(day);
      adjusted.setHours(startHour, startMinute, 0, 0);
      return adjusted;
    };

    candidate = adjustToMonthlyDay(startDateTime);
    if (candidate < startDateTime) {
      candidate = adjustToMonthlyDay(new Date(startDateTime.getFullYear(), startDateTime.getMonth() + 1, 1));
    }

    let attempts = 0;
    while (candidate < now && attempts < 240) {
      candidate = adjustToMonthlyDay(new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1));
      attempts++;
    }

    if (attempts >= 240) {
      return null;
    }
  } else {
    return null;
  }

  if (!candidate) {
    return null;
  }

  if (candidate < startDateTime) {
    candidate = new Date(startDateTime);
  }

  if (endDateTime && candidate > endDateTime) {
    return null;
  }

  return candidate;
}

function loadScheduledMessages() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE_PATH)) {
      scheduledMessages = [];
      return;
    }

    const raw = fs.readFileSync(SCHEDULE_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    scheduledMessages = Array.isArray(data) ? data : [];

    let updated = false;
    const now = new Date();

    scheduledMessages.forEach(schedule => {
      if (schedule.status !== 'active') {
        return;
      }

      const nextRun = schedule.nextRun ? new Date(schedule.nextRun) : null;
      if (!nextRun || Number.isNaN(nextRun.getTime()) || nextRun < now) {
        const computed = computeNextRunForSchedule(schedule, now);
        if (computed) {
          schedule.nextRun = computed.toISOString();
        } else {
          schedule.status = 'completed';
          schedule.nextRun = null;
        }
        updated = true;
      }
    });

    if (updated) {
      saveScheduledMessages();
    }
  } catch (error) {
    console.error('[SCHEDULE] Error loading scheduled messages:', error);
    scheduledMessages = [];
  }
}

function saveScheduledMessages() {
  try {
    fs.writeFileSync(SCHEDULE_FILE_PATH, JSON.stringify(scheduledMessages, null, 2), 'utf-8');
  } catch (error) {
    console.error('[SCHEDULE] Error saving scheduled messages:', error);
  }
}

async function processScheduledMessages() {
  if (isProcessingSchedules) {
    return;
  }
  isProcessingSchedules = true;

  try {
    if (!scheduledMessages.length) {
      return;
    }

    const now = new Date();
    let updated = false;

    for (const schedule of scheduledMessages) {
      if (schedule.status !== 'active') {
        continue;
      }

      if (!schedule.nextRun) {
        const next = computeNextRunForSchedule(schedule, now);
        if (next) {
          schedule.nextRun = next.toISOString();
        } else {
          schedule.status = 'completed';
        }
        updated = true;
        continue;
      }

      const nextRunDate = new Date(schedule.nextRun);
      if (Number.isNaN(nextRunDate.getTime())) {
        schedule.status = 'completed';
        schedule.nextRun = null;
        updated = true;
        continue;
      }

      if (nextRunDate > now) {
        continue;
      }

      console.log(`[SCHEDULE] Executing schedule ${schedule.id} for group ${schedule.groupName} at ${now.toISOString()}`);

      const result = await sendGroupMessageInternal(schedule.groupName, {
        message: schedule.message,
        mediaUrl: schedule.mediaUrl,
        mediaType: schedule.mediaType,
        mediaFilename: schedule.mediaFilename,
        hasMedia: schedule.hasMedia,
        selectedPhones: schedule.targetScope === 'selected' ? schedule.selectedPhones : undefined
      });

      if (result.status === 'sent') {
        schedule.lastRunAt = now.toISOString();
        schedule.lastError = null;
        const next = computeNextRunForSchedule(schedule, new Date(now.getTime() + 60000));
        if (next) {
          schedule.nextRun = next.toISOString();
        } else {
          schedule.nextRun = null;
          schedule.status = 'completed';
          console.log(`[SCHEDULE] Schedule ${schedule.id} completed (no further runs)`);
        }
      } else if (result.status === 'client_not_ready') {
        schedule.lastError = 'WhatsApp client not ready';
        const retry = new Date(now.getTime() + 60 * 1000);
        schedule.nextRun = retry.toISOString();
        console.warn(`[SCHEDULE] WhatsApp client not ready. Schedule ${schedule.id} will retry at ${schedule.nextRun}`);
      } else {
        const errorMessage = result.error ? (result.error.message || result.error.toString()) : 'Unknown error';
        schedule.lastError = errorMessage;
        const retry = new Date(now.getTime() + 5 * 60 * 1000);
        const endDateTime = combineScheduleDateTime(schedule.endDate, schedule.endTime);
        if (endDateTime && retry > endDateTime) {
          schedule.status = 'completed';
          schedule.nextRun = null;
          console.error(`[SCHEDULE] Schedule ${schedule.id} failed and end window passed. Marking completed. Error: ${errorMessage}`);
        } else {
          schedule.nextRun = retry.toISOString();
          console.error(`[SCHEDULE] Schedule ${schedule.id} failed. Retrying at ${schedule.nextRun}. Error: ${errorMessage}`);
        }
      }

      updated = true;
    }

    if (updated) {
      saveScheduledMessages();
    }
  } catch (error) {
    console.error('[SCHEDULE] Error processing scheduled messages:', error);
  } finally {
    isProcessingSchedules = false;
  }
}

function startScheduleChecker() {
  loadScheduledMessages();

  if (scheduleChecker) {
    clearInterval(scheduleChecker);
  }

  scheduleChecker = setInterval(() => {
    processScheduledMessages().catch(err => console.error('[SCHEDULE] Scheduler loop error:', err));
  }, SCHEDULE_CHECK_INTERVAL);

  processScheduledMessages().catch(err => console.error('[SCHEDULE] Initial scheduler run error:', err));
}

async function updateAttendance(groupName, customerPhone, status = 'present', month = null, message = '', messageTimestamp = null) {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) return false;

    console.log(`[ATTENDANCE] Updating attendance for group: ${groupName}, customer: ${customerPhone}, message: ${message ? message.substring(0, 50) : '(none)'}`);

    // Find the customer in the group
    const group = customerGroups[groupName];
    if (!group) {
      console.log(`[ERROR] Group not found: ${groupName}`);
      return false;
    }

    console.log(`[DEBUG] Looking for customer with phone: ${customerPhone}`);
    console.log(`[DEBUG] Group has ${group.customers.length} customers`);
    
    const customer = group.customers.find(c => {
      const customerPhoneClean = customerPhone.replace(/\D/g, '');
      const cPhoneClean = c.phone.replace(/\D/g, '');
      console.log(`[DEBUG] Comparing: ${c.phone} (${c.name}) - clean: ${cPhoneClean} vs ${customerPhoneClean}`);
      return cPhoneClean === customerPhoneClean;
    });
    
    if (!customer) {
      console.log(`[DEBUG] Customer not found. Group phones: ${group.customers.map(c => c.phone).join(', ')}`);
      return false;
    }

    // Use the customer's phone from the group (normalized)
    const normalizedPhone = customer.phone;
    
    // Initialize attendance data structure
    if (!attendanceData[groupName]) {
      attendanceData[groupName] = {};
    }
    if (!attendanceData[groupName][normalizedPhone]) {
      attendanceData[groupName][normalizedPhone] = {};
    }

    // Determine the date from message timestamp or use current date
    let attendanceDate;
    if (messageTimestamp) {
      // Use message timestamp to get the date
      const messageDate = new Date(messageTimestamp * 1000); // Convert Unix seconds to milliseconds
      attendanceDate = messageDate.toISOString().slice(0, 10); // YYYY-MM-DD
    } else {
      // Fall back to current date if no timestamp
      attendanceDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }
    
    // Use provided month or determine from attendance date (YYYY-MM format)
    const targetMonth = month || attendanceDate.slice(0, 7);

    // Initialize month array if not exists
    if (!attendanceData[groupName][normalizedPhone][targetMonth]) {
      attendanceData[groupName][normalizedPhone][targetMonth] = [];
    }

    // Add the attendance date if not already present
    if (!attendanceData[groupName][normalizedPhone][targetMonth].includes(attendanceDate)) {
      attendanceData[groupName][normalizedPhone][targetMonth].push(attendanceDate);
      console.log(`Attendance marked for ${customer.name} (${normalizedPhone}) on ${attendanceDate} in month ${targetMonth}`);
      
      // Write to Attendance sheet (Date, Time, Group, Member, Message)
      // Use message timestamp if provided, otherwise use current time
      try {
        await writeAttendanceToSheet(groupName, customer.name, customer.phone, message, messageTimestamp);
        console.log(`Attendance written to Attendance sheet for ${customer.name}`);
      } catch (sheetError) {
        console.error('Error writing to Attendance sheet:', sheetError);
        // Don't fail the request if sheet update fails
        console.log('Continuing despite Attendance sheet write error...');
      }
    }

    return true;
  } catch (error) {
    console.error('Error updating attendance:', error);
    return false;
  }
}

// Initialize scheduler
startScheduleChecker();

// Initialize WhatsApp client
client.initialize();

// Memory cleanup function
function performMemoryCleanup() {
  try {
    // Force garbage collection if available (requires --expose-gc flag)
    if (global.gc) {
      global.gc();
      console.log('🧹 Memory cleanup: Garbage collection triggered');
    }
    
    // Log memory usage
    const memUsage = process.memoryUsage();
    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };
    
    console.log('📊 Memory usage:', memUsageMB);
    
    // Warn if memory usage is high
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > MEMORY_WARNING_THRESHOLD * 100) {
      console.warn(`⚠️ High memory usage: ${heapUsagePercent.toFixed(1)}% of heap used`);
    }
  } catch (error) {
    console.error('Error during memory cleanup:', error);
  }
}

// Start periodic memory cleanup
setInterval(performMemoryCleanup, MEMORY_CLEANUP_INTERVAL);
console.log(`✅ Memory cleanup scheduled every ${MEMORY_CLEANUP_INTERVAL / 1000 / 60} minutes`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log(`💾 Memory limits: ${MAX_MESSAGES_PER_REQUEST} messages per request, ${MAX_MESSAGES_PER_CHAT} per chat`);
  
  // Log initial memory usage
  const initialMem = process.memoryUsage();
  console.log('📊 Initial memory usage:', {
    rss: Math.round(initialMem.rss / 1024 / 1024) + ' MB',
    heapTotal: Math.round(initialMem.heapTotal / 1024 / 1024) + ' MB',
    heapUsed: Math.round(initialMem.heapUsed / 1024 / 1024) + ' MB'
  });
  
  // Note about garbage collection
  if (global.gc) {
    console.log('✅ Garbage collection enabled (--expose-gc flag set)');
  } else {
    console.log('ℹ️  Garbage collection not enabled. For better memory management, start with: node --expose-gc server.js');
  }
});

// List scheduled messages
app.get('/schedules', async (req, res) => {
  try {
    await ensureGroupData();
    const { groupName } = req.query;
    let schedules = scheduledMessages;

    if (groupName) {
      schedules = schedules.filter(schedule => schedule.groupName === groupName);
    }

    res.json({ success: true, schedules });
  } catch (error) {
    console.error('[SCHEDULE] Error listing schedules:', error);
    res.status(500).json({ success: false, error: 'Failed to load schedules', details: error.message });
  }
});

// Update an existing schedule
app.put('/schedules/:scheduleId', async (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const existingSchedule = scheduledMessages[scheduleIndex];
    await ensureGroupData();
    const group = customerGroups[existingSchedule.groupName];
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const validation = validateSchedulePayload(group, req.body, existingSchedule, { requireFutureStart: false });
    if (validation.error) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const value = validation.value;

    existingSchedule.message = value.message;
    existingSchedule.mediaUrl = value.mediaUrl;
    existingSchedule.mediaType = value.mediaType;
    existingSchedule.mediaFilename = value.mediaFilename;
    existingSchedule.hasMedia = value.hasMedia;
    existingSchedule.targetScope = value.targetScope;
    existingSchedule.selectedPhones = value.targetScope === 'selected' ? value.selectedPhones : [];
    existingSchedule.recurrenceType = value.recurrenceType;
    existingSchedule.weekdays = value.weekdays;
    existingSchedule.monthlyDay = value.monthlyDay;
    existingSchedule.startDate = value.startDate;
    existingSchedule.startTime = value.startTime;
    existingSchedule.endDate = value.endDate;
    existingSchedule.endTime = value.endTime;
    existingSchedule.timezone = value.timezone || existingSchedule.timezone;
    existingSchedule.updatedAt = new Date().toISOString();
    existingSchedule.status = 'active';
    existingSchedule.lastError = null;

    const nextRun = computeNextRunForSchedule(existingSchedule);
    if (nextRun) {
      existingSchedule.nextRun = nextRun.toISOString();
    } else {
      existingSchedule.nextRun = null;
      existingSchedule.status = 'completed';
    }

    saveScheduledMessages();

    processScheduledMessages().catch(err => console.error('[SCHEDULE] Scheduler run error after update:', err));

    res.json({
      success: true,
      scheduleId: existingSchedule.id,
      nextRun: existingSchedule.nextRun,
      status: existingSchedule.status
    });
  } catch (error) {
    console.error('[SCHEDULE] Error updating schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to update schedule', details: error.message });
  }
});

// Delete a schedule
app.delete('/schedules/:scheduleId', (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const [removedSchedule] = scheduledMessages.splice(scheduleIndex, 1);
    saveScheduledMessages();

    res.json({ success: true, scheduleId: removedSchedule.id });
  } catch (error) {
    console.error('[SCHEDULE] Error deleting schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to delete schedule', details: error.message });
  }
});
