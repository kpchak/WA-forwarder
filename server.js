require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
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
app.use(express.static('public'));

// WhatsApp client setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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
    
    // Emit QR code to all connected clients
    io.emit('qrCode', { qrData: qr, qrImage: url });
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
  io.emit('clientDisconnected', { reason });
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
      const isIncoming = !msg.fromMe; // Only show messages received from customers, not sent to them
      return isWithinTimeRange && isIncoming;
    });
    
    console.log(`Recent messages (last ${days} days):`, recentMessages.length);
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

// Endpoint for secret code monitoring with specific phone numbers
app.post('/messages-merged', async (req, res) => {
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  const { phoneNumbers } = req.body;
  
  if (!phoneNumbers || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'No phone numbers provided' });
  }
  
  // Set a timeout for the entire request
  const timeout = setTimeout(() => {
    console.log('Request timeout - taking too long to fetch messages');
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout - too many messages to process' });
    }
  }, 120000); // 120 second timeout (2 minutes)
  
  try {
    console.log('Fetching merged messages for secret code monitoring:', phoneNumbers);
    
    let allMessages = [];
    const uniqueMessages = new Set();
    
    // Include both individual contacts and group chats
    const allContacts = phoneNumbers;
    
    console.log(`Processing ${allContacts.length} contacts/groups from ${phoneNumbers.length} total phone numbers`);
    
    for (let i = 0; i < allContacts.length; i++) {
      const phoneNumber = allContacts[i];
      console.log(`Processing contact/group ${i + 1}/${allContacts.length}: ${phoneNumber}`);
      
      try {
        const chatId = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@c.us`;
        const sourcePhoneClean = (phoneNumber.includes('@') ? phoneNumber.replace(/@.*/, '') : phoneNumber).replace(/\D/g, '');
        console.log('Getting chat for ID:', chatId);
        
        const chat = await client.getChatById(chatId);
        const chatName = chat.name || 'Unknown';
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
            total: allContacts.length,
            phoneNumber: phoneNumber,
            chatName: chatName
          });
        }
        
        console.log(`Fetching messages for ${phoneNumber}...`);
        
        // Priority: Check for filters to determine message fetch limit
        let days = 0;
        let timeFilterStart = 0;
        let timeFilterEnd = 0;
        let estimatedLimit, messages;
        
        if (req.query.datetimeFilter === 'true' || req.body.datetimeFilter === 'true') {
          // Check if we have from/to timestamps for precise filtering
          const fromTimestamp = req.query.from || req.body.from;
          const toTimestamp = req.query.to || req.body.to;
          
          if (fromTimestamp && toTimestamp) {
            timeFilterStart = parseInt(fromTimestamp);
            timeFilterEnd = parseInt(toTimestamp);
            days = Math.ceil((timeFilterEnd - timeFilterStart) / (1000 * 60 * 60 * 24));
            estimatedLimit = Math.max(50, days * 50);
            messages = await chat.fetchMessages({ limit: estimatedLimit });
            console.log(`Using precise datetime filter from=${new Date(timeFilterStart).toLocaleString()}, to=${new Date(timeFilterEnd).toLocaleString()}, days=${days}`);
          } else {
            // Fallback to days-based filtering
            days = parseInt(req.query.days) || parseInt(req.body.days) || 7;
            estimatedLimit = Math.max(50, days * 50);
            messages = await chat.fetchMessages({ limit: estimatedLimit });
            const now = Date.now();
            timeFilterStart = now - (days * 24 * 60 * 60 * 1000);
            timeFilterEnd = now;
            console.log(`Using days-based filter: days=${days}, limit=${estimatedLimit}`);
          }
        } else if (req.query.hours || req.body.hours) {
          // Hours filter
          const hours = parseInt(req.query.hours) || parseInt(req.body.hours);
          days = Math.ceil(hours / 24);
          estimatedLimit = Math.max(50, days * 50);
          messages = await chat.fetchMessages({ limit: estimatedLimit });
          const now = Date.now();
          timeFilterStart = now - (hours * 60 * 60 * 1000);
          timeFilterEnd = now;
          console.log(`Using hours-based filter: hours=${hours}, limit=${estimatedLimit}`);
        } else if (req.query.days || req.body.days) {
          // Days filter
          days = parseInt(req.query.days) || parseInt(req.body.days);
          estimatedLimit = Math.max(50, days * 50);
          messages = await chat.fetchMessages({ limit: estimatedLimit });
          const now = Date.now();
          timeFilterStart = now - (days * 24 * 60 * 60 * 1000);
          timeFilterEnd = now;
          console.log(`Using days-based filter: days=${days}, limit=${estimatedLimit}`);
        } else {
          // No filter - load only last 5 messages for fast loading
          estimatedLimit = 5;
          messages = await chat.fetchMessages({ limit: estimatedLimit });
          console.log(`No filter - loading last 5 messages only for fast performance`);
        }
        
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
        }
        
        // Filter messages from the specified time range AND only incoming messages (not from me)
        const recentMessages = messages.filter(msg => {
          const messageDate = msg.timestamp * 1000;
          const isWithinTimeRange = timeFilterStart === 0 || (messageDate >= timeFilterStart && messageDate <= timeFilterEnd);
          const isIncoming = !msg.fromMe; // Only show messages received from customers, not sent to them
          return isWithinTimeRange && isIncoming;
        });
        
        if (timeFilterStart > 0 && timeFilterEnd > 0) {
          console.log(`Recent messages from ${phoneNumber} (custom range ${new Date(timeFilterStart).toLocaleString()} to ${new Date(timeFilterEnd).toLocaleString()}):`, recentMessages.length);
        } else {
          console.log(`Recent messages from ${phoneNumber} (last ${days} days):`, recentMessages.length);
        }
        
        // Debug: Show some sample recent messages
        if (recentMessages.length > 0) {
          console.log(`Sample recent messages from ${phoneNumber}:`);
          recentMessages.slice(0, 3).forEach((msg, index) => {
            console.log(`  ${index + 1}. "${msg.body}" at ${new Date(msg.timestamp * 1000).toLocaleString()}`);
          });
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
        
        // Process each recent message
        for (const msg of recentMessages) {
          const messageId = `${msg.fromMe}_${msg.from}_${msg.id}`;
          
          if (uniqueMessages.has(messageId)) {
            continue; // Skip duplicate messages
          }
          uniqueMessages.add(messageId);
          
          // Get sender information
          let senderName = 'Unknown';
          let senderPhone = '';
          
          if (msg.fromMe) {
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
          
          // Format message data
          const messageData = {
            id: messageId,
            body: msg.body || '',
            timestamp: msg.timestamp,
            from: msg.from,
            fromMe: msg.fromMe,
            senderName: senderName,
            senderPhone: senderPhone,
            chatName: chatName,
            sourcePhone: sourcePhoneClean,
            hasMedia: msg.hasMedia,
            type: msg.type
          };
          
          // Skip media download for now to improve performance
          // Media can be downloaded on-demand when user clicks on a message
          if (msg.hasMedia) {
            messageData.mediaNote = 'Media available - click to download';
          }
          
          allMessages.push(messageData);
        }
        
        // Add a small delay between processing each phone number to prevent overwhelming the API
        if (i < phoneNumbers.length - 1) {
          console.log('Waiting 25ms before next request...');
          await new Promise(resolve => setTimeout(resolve, 25)); // Reduced delay
        }
        
      } catch (error) {
        console.error(`Error fetching messages from ${phoneNumber}:`, error);
        // Continue with next phone number instead of failing completely
      }
    }
    
    console.log(`Total unique messages found: ${allMessages.length}`);
    
    // Clear timeout since we completed successfully
    clearTimeout(timeout);
    
    if (!res.headersSent) {
      res.json({
        messages: allMessages,
        totalMessages: allMessages.length,
        phoneNumbers: phoneNumbers
      });
    }
    
  } catch (error) {
    console.error('Error fetching merged messages:', error);
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  }
});

// New endpoint to get merged messages from all phone numbers
app.get('/messages-merged', async (req, res) => {
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  if (targetPhoneNumbers.length === 0) {
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
    console.log('Fetching merged messages for:', targetPhoneNumbers);
    
    // Process all contacts and groups
    const allContacts = targetPhoneNumbers;
    
    console.log(`Processing ${allContacts.length} contacts/groups from ${targetPhoneNumbers.length} total phone numbers`);
    
    let allMessages = [];
    const messageIds = new Set(); // To track unique messages
    
    // Fetch messages from each contact/group
    for (let i = 0; i < allContacts.length; i++) {
      const phoneNumber = allContacts[i];
      console.log(`Processing contact/group ${i + 1}/${allContacts.length}: ${phoneNumber}`);
      
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
        const chat = await client.getChatById(chatId);
        const chatName = chat.name || 'Unknown';
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
            total: allContacts.length, 
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
        const estimatedLimit = days > 0 ? Math.max(50, days * 50) : 350; // Default to 350 messages if no filter
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
          const isIncoming = !msg.fromMe; // Only show messages received from customers, not sent to them
          return isWithinTimeRange && isIncoming;
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
        // Continue with other phone numbers even if one fails
      }
      
        // Add a small delay between requests to prevent overwhelming the API
        if (i < allContacts.length - 1) {
          console.log('Waiting 25ms before next request...');
          await new Promise(resolve => setTimeout(resolve, 25)); // Reduced from 50ms to 25ms for faster loading
        }
    }
    
    // Sort messages by timestamp (newest first)
    allMessages.sort((a, b) => b.timestamp - a.timestamp);
    
    console.log(`Total unique messages found: ${allMessages.length}`);
    
    // Clear the timeout since we're responding
    clearTimeout(timeout);
    
    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      res.json({ 
        messages: allMessages,
        totalMessages: allMessages.length,
        phoneNumbers: allContacts
      });
    }
  } catch (error) {
    console.error('Error fetching merged messages:', error);
    clearTimeout(timeout);
    
    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to fetch merged messages', 
        details: error.message 
      });
    }
  }
});

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
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  
  const { messageId, chatId } = req.body;
  
  if (!messageId || !chatId) {
    return res.status(400).json({ error: 'Message ID and Chat ID are required' });
  }
  
  try {
    console.log(`Downloading media for message ${messageId} from chat ${chatId}`);
    
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    
    const message = messages.find(msg => msg.id._serialized === messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    if (!message.hasMedia) {
      return res.status(400).json({ error: 'Message does not contain media' });
    }
    
    const media = await message.downloadMedia();
    
    if (!media) {
      return res.status(500).json({ error: 'Failed to download media' });
    }
    
    res.json({
      success: true,
      mediaUrl: `data:${media.mimetype};base64,${media.data}`,
      mediaFilename: media.filename || `media_${messageId}`,
      mediaMimetype: media.mimetype,
      mediaSize: media.data.length
    });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ 
      error: 'Failed to download media', 
      details: error.message 
    });
  }
});

// Google Sheets Group Management Endpoints

// Load customer groups from Google Sheets
app.get('/groups/load', async (req, res) => {
  try {
    console.log('Loading customer groups from Google Sheets...');
    customerGroups = await loadCustomerGroups();
    
    res.json({
      success: true,
      groups: customerGroups,
      totalGroups: Object.keys(customerGroups).length,
      message: 'Customer groups loaded successfully'
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
    const { message, mediaUrl, mediaType, mediaFilename, hasMedia, selectedPhones } = req.body;
    
    console.log('Forward request received:', {
      groupName,
      hasMessage: !!message,
      hasMedia: hasMedia,
      mediaType,
      mediaFilename,
      mediaUrlLength: mediaUrl ? mediaUrl.length : 0,
      selectedPhonesCount: selectedPhones ? selectedPhones.length : 'all'
    });
    
    if (!message && !mediaUrl) {
      return res.status(400).json({
        success: false,
        error: 'Message content is required'
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

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    // Filter customers if selectedPhones is provided
    let customersToMessage = group.customers;
    if (selectedPhones && Array.isArray(selectedPhones) && selectedPhones.length > 0) {
      customersToMessage = group.customers.filter(customer => 
        selectedPhones.includes(customer.phone)
      );
      console.log(`Filtering to ${customersToMessage.length} selected customers out of ${group.customers.length} total`);
    }

    // Send message to each selected customer
    for (const customer of customersToMessage) {
      try {
        const chatId = `${customer.phone}@c.us`;
        const chat = await client.getChatById(chatId);
        
        if (hasMedia && mediaUrl && mediaType) {
          console.log(`Sending media to ${customer.phone}:`, {
            mediaType,
            mediaFilename,
            isBase64: mediaUrl.startsWith('data:'),
            mediaSize: mediaUrl.length
          });
          
          // Handle base64 media data
          if (mediaUrl.startsWith('data:')) {
            // Extract base64 data from data URL
            const base64Data = mediaUrl.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Create a temporary file path
            const fs = require('fs');
            const path = require('path');
            const tempDir = path.join(__dirname, 'temp');
            
            // Ensure temp directory exists
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }
            
            const tempFilePath = path.join(tempDir, `${Date.now()}_${mediaFilename || 'media'}`);
            fs.writeFileSync(tempFilePath, buffer);
            
            try {
              // Send media with caption using MessageMedia
              const mediaMessage = new MessageMedia(mediaType, base64Data);
              await chat.sendMessage(mediaMessage, { caption: message });
            } catch (error) {
              console.error('Error sending media message:', error);
              // Fallback: try sending as regular message with media URL
              await chat.sendMessage(message);
            } finally {
              // Clean up temp file
              if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
              }
            }
          } else {
            // Regular URL
            await chat.sendMessage(mediaUrl, { caption: message });
          }
        } else {
          // Send text message
          await chat.sendMessage(message);
        }
        
        successCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'sent',
          timestamp: new Date().toISOString()
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        });
        console.error(`Failed to send message to ${customer.name} (${customer.phone}):`, error);
      }
    }

    res.json({
      success: true,
      groupName: groupName,
      totalCustomers: customersToMessage.length,
      successCount: successCount,
      errorCount: errorCount,
      results: results,
      message: `Message sent to ${successCount} out of ${customersToMessage.length} selected customers`
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

// Update attendance for a customer
app.post('/groups/:groupName/attendance', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { customerPhone, status = 'present', month } = req.body;
    
    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Customer phone number is required'
      });
    }

    // Use provided month or default to current month (YYYY-MM format)
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    
    const success = await updateAttendance(groupName, customerPhone, status, targetMonth);
    
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

async function loadCustomerGroups() {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      console.log('Google Sheets not configured');
      return {};
    }

    // Get all sheet names
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });

    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
    console.log('Available sheets:', sheetNames);

    const groups = {};

    for (const sheetName of sheetNames) {
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
          
          // Format phone number
          let formattedPhone = phone.replace(/\D/g, ''); // Remove non-digits
          if (formattedPhone && !formattedPhone.startsWith('91')) {
            formattedPhone = '91' + formattedPhone;
          }
          
          return {
            phone: formattedPhone,
            name: name || phone,
            originalPhone: phone
          };
        }).filter(customer => customer.phone && customer.phone.length >= 10);

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

    return groups;
  } catch (error) {
    console.error('Error loading customer groups:', error);
    return {};
  }
}

async function updateAttendance(groupName, customerPhone, status = 'present', month = null) {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) return false;

    // Find the customer in the group
    const group = customerGroups[groupName];
    if (!group) return false;

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

    // Use provided month or current month (YYYY-MM format)
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const todayFormatted = new Date().toISOString().slice(8, 10); // DD (day only)

    // Initialize month array if not exists
    if (!attendanceData[groupName][normalizedPhone][targetMonth]) {
      attendanceData[groupName][normalizedPhone][targetMonth] = [];
    }

    // Add today's date if not already present
    if (!attendanceData[groupName][normalizedPhone][targetMonth].includes(today)) {
      attendanceData[groupName][normalizedPhone][targetMonth].push(today);
      console.log(`Attendance marked for ${customer.name} (${normalizedPhone}) on ${today} in month ${targetMonth}`);
      
      // Update Google Sheet with attendance
      try {
        // Get the sheet data to find the row for this customer
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!A:Z`
        });

        const rows = response.data.values;
        if (!rows || rows.length < 2) {
          console.log('No data found in sheet');
          return true; // Return true even if sheet update fails
        }

        const headers = rows[0];
        const phoneCol = headers.findIndex(h => 
          h && (h.toLowerCase().includes('phone') || 
          h.toLowerCase().includes('number') ||
          h.toLowerCase().includes('whatsapp'))
        );

        // Find the customer's row
        let customerRow = -1;
        for (let i = 1; i < rows.length; i++) {
          const rowPhone = rows[i][phoneCol] ? rows[i][phoneCol].toString().replace(/\D/g, '') : '';
          const cleanCustomerPhone = customerPhone.replace(/\D/g, '');
          if (rowPhone === cleanCustomerPhone) {
            customerRow = i + 1; // +1 because Google Sheets is 1-indexed
            break;
          }
        }

        if (customerRow === -1) {
          console.log(`Customer not found in sheet: ${customer.name} (${customerPhone})`);
          return true; // Return true even if customer not found
        }

        // Find or create the attendance column for today's date (DD format)
        let dateCol = -1;
        const dateColumnName = todayFormatted; // Column header is just the day (DD)
        
        // First, try to find existing date column
        for (let i = 0; i < headers.length; i++) {
          if (headers[i] && headers[i].toString().trim() === dateColumnName) {
            dateCol = i;
            break;
          }
        }

        // Helper function to get column letter from index (supports AA, AB, etc.)
        const getColumnLetter = (index) => {
          let result = '';
          let num = index;
          while (num >= 0) {
            result = String.fromCharCode(65 + (num % 26)) + result;
            num = Math.floor(num / 26) - 1;
          }
          return result;
        };

        // If column doesn't exist, create it
        if (dateCol === -1) {
          // Find the last column
          dateCol = headers.length;
          // Add the new column header
          await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
            range: `${groupName}!${getColumnLetter(dateCol)}1`, // Column letter for the new column
            valueInputOption: 'RAW',
            resource: {
              values: [[dateColumnName]]
            }
          });
          console.log(`Created new attendance column: ${dateColumnName}`);
        }

        // Update the attendance cell with "P" (Present)
        const columnLetter = getColumnLetter(dateCol);
        await sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!${columnLetter}${customerRow}`,
          valueInputOption: 'RAW',
          resource: {
            values: [['P']]
          }
        });

        console.log(`Updated Google Sheet: ${groupName}!${columnLetter}${customerRow} = P`);
        console.log(`Attendance written to Google Sheets for ${customer.name}`);

      } catch (sheetError) {
        console.error('Error updating Google Sheet:', sheetError);
        // Don't fail the request if sheet update fails
        console.log('Continuing despite sheet update error...');
      }
    }

    return true;
  } catch (error) {
    console.error('Error updating attendance:', error);
    return false;
  }
}

// Function to update customer attendance for manual secret code finder
async function updateCustomerAttendance(phoneNumber, status, groupKey, secretCode = 'CODE') {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) return false;

    // Resolve group by name first, then by optional id field
    let groupName = null;
    if (groupKey && customerGroups[groupKey]) {
      groupName = groupKey; // Direct name match (sheet/tab name)
    }
    if (!groupName && groupKey) {
      const byId = Object.keys(customerGroups).find(name => customerGroups[name].id === groupKey);
      if (byId) groupName = byId;
    }
    
    if (!groupName) {
      console.log(`Group not found for key: ${groupKey}`);
      return false;
    }

    const group = customerGroups[groupName];
    if (!group) return false;

    // Find the customer in the group
    const customer = group.customers.find(c => {
      const customerPhoneClean = phoneNumber.replace(/\D/g, '');
      const cPhoneClean = c.phone.replace(/\D/g, '');
      return cPhoneClean === customerPhoneClean;
    });
    
    if (!customer) {
      console.log(`Customer with phone ${phoneNumber} not found in group ${groupName}`);
      return false;
    }

    // Get today's date in YYYYMMDD format for the code column
    const today = new Date();
    const dateCode = today.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format
    const codeColumnName = `${dateCode}${secretCode}`; // e.g., "20251029P" or "20251029Gift"

    // Get the sheet data to find the row for this customer
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: `${groupName}!A:Z`
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
      console.log(`No data found in sheet ${groupName}`);
      return false;
    }

    // Find the customer row
    let customerRow = -1;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] && row[0].replace(/\D/g, '') === customer.phone.replace(/\D/g, '')) {
        customerRow = i + 1; // Google Sheets is 1-indexed
        break;
      }
    }

    if (customerRow === -1) {
      console.log(`Customer row not found for ${customer.name} in sheet ${groupName}`);
      return false;
    }

    // Find or create the code column for today's date
    const headerRow = rows[0];
    let codeCol = -1;
    
    // Look for existing code column
    for (let i = 0; i < headerRow.length; i++) {
      if (headerRow[i] === codeColumnName) {
        codeCol = i;
        break;
      }
    }

    // If code column doesn't exist, create it
    if (codeCol === -1) {
      codeCol = headerRow.length;
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
        range: `${groupName}!${getColumnLetter(codeCol)}1`,
        valueInputOption: 'RAW',
        resource: {
          values: [[codeColumnName]]
        }
      });
      console.log(`Created new code column: ${codeColumnName}`);
    }

    // Update the code cell with the secret code confirmation
    const columnLetter = getColumnLetter(codeCol);
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: `${groupName}!${columnLetter}${customerRow}`,
      valueInputOption: 'RAW',
      resource: {
        values: [['Y']] // Always mark as Y for secret code confirmation
      }
    });

    console.log(`Updated Google Sheet: ${groupName}!${columnLetter}${customerRow} = Y`);
    console.log(`Secret code confirmation written to Google Sheets for ${customer.name} in column ${codeColumnName}`);

    return true;
  } catch (error) {
    console.error('Error updating customer attendance:', error);
    return false;
  }
}

// API endpoint to update customer attendance
app.post('/api/update-attendance', async (req, res) => {
  try {
    const { phoneNumber, status, groupId, groupName, secretCode } = req.body;
    
    const groupKey = groupName || groupId; // accept either

    if (!phoneNumber || !status || !groupKey) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    console.log(`Updating attendance for ${phoneNumber} to ${status} in group ${groupKey} with secret code: ${secretCode || 'CODE'}`);
    
    // Update Google Sheets
    const success = await updateCustomerAttendance(phoneNumber, status, groupKey, secretCode || 'CODE');
    
    if (success) {
      res.json({ success: true, message: 'Attendance updated successfully' });
    } else {
      res.status(500).json({ error: 'Failed to update attendance' });
    }
    
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize WhatsApp client
client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
