// Socket.IO connection
console.log('🔌 Initializing Socket.IO connection...');
const socket = io();

// Test if page is loading
console.log('📄 Script.js loaded successfully!');

// DOM elements
const statusCard = document.getElementById('statusCard');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const qrSection = document.getElementById('qrSection');
const phoneSection = document.getElementById('phoneSection');
const messagesSection = document.getElementById('messagesSection');
const phoneInput = document.getElementById('phoneInput');
const addPhoneBtn = document.getElementById('addPhoneBtn');
const setPhoneBtn = document.getElementById('setPhoneBtn');
const clearPhonesBtn = document.getElementById('clearPhonesBtn');
const saveListBtn = document.getElementById('saveListBtn');
const loadListBtn = document.getElementById('loadListBtn');
const customerListBtn = document.getElementById('customerListBtn');
const phoneList = document.getElementById('phoneList');
const loadChatsBtn = document.getElementById('loadChatsBtn');
const chatList = document.getElementById('chatList');
const showAllBtn = document.getElementById('showAllBtn');
const showContactsBtn = document.getElementById('showContactsBtn');
const showGroupsBtn = document.getElementById('showGroupsBtn');
const targetPhoneDisplay = document.getElementById('targetPhoneDisplay');
const messagesContainer = document.getElementById('messagesContainer');
const loadingMessages = document.getElementById('loadingMessages');
const refreshBtn = document.getElementById('refreshBtn');
const errorMessage = document.getElementById('errorMessage');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const loadMoreContainer = document.getElementById('loadMoreContainer');
const messageCountInfo = document.getElementById('messageCountInfo');
const errorText = document.getElementById('errorText');
const scrollToBottomBtn = document.getElementById('scrollToBottom');

// New DOM elements for groups
const navBtns = document.querySelectorAll('.nav-btn');
const groupsSection = document.getElementById('groupsSection');
const groupMessageSection = document.getElementById('groupMessageSection');
const loadGroupsBtn = document.getElementById('loadGroupsBtn');
const refreshGroupsBtn = document.getElementById('refreshGroupsBtn');
const groupsContainer = document.getElementById('groupsContainer');
const loadingGroups = document.getElementById('loadingGroups');
const backToGroupsBtn = document.getElementById('backToGroupsBtn');
const groupMessageInput = document.getElementById('groupMessageInput');
const groupMediaInput = document.getElementById('groupMediaInput');
const sendGroupMessageBtn = document.getElementById('sendGroupMessageBtn');
const previewGroupBtn = document.getElementById('previewGroupBtn');
const groupMessageResults = document.getElementById('groupMessageResults');
const recipientsList = document.getElementById('recipientsList');
const selectAllRecipientsBtn = document.getElementById('selectAllRecipientsBtn');
const deselectAllRecipientsBtn = document.getElementById('deselectAllRecipientsBtn');
const recipientCountBadge = document.getElementById('recipientCountBadge');

// Text filter elements (will be initialized in DOMContentLoaded)
let textFilter, applyTextFilter, clearTextFilter;

// Hours filter elements (will be initialized in DOMContentLoaded)
let hoursFilter, applyHoursFilter, clearHoursFilter;

// Customer filter elements (will be initialized in DOMContentLoaded)
let applyCustomerFilter, clearCustomerFilter;

// Secret code monitoring elements (will be initialized in DOMContentLoaded)
let secretCodeInput, secretCodeGroupSelect, secretCodeTimeRange, includeThumbsUp;
let secretCodeResults, secretCodeList, totalCustomers, respondedCount, notRespondedCount;
let selectAllResponded, selectAllNotResponded, sendReminderBtn;

// Time filter elements (will be initialized in DOMContentLoaded)
let fromDate, toDate, fromTimeSlider, toTimeSlider, fromTimeDisplay, toTimeDisplay, applyTimeFilter, clearTimeFilter, resetTimeFilter;
let timeRangeSummary, summaryText, summaryDetails;
let presetButtons;

// State
let isConnected = false;
let currentGroups = {};
let selectedGroup = null;
let currentPhoneNumbers = [];
let allChats = [];
let currentFilter = 'all';
let textFilterEnabled = false;
let textFilterPattern = '';
let selectedCustomerPhone = null;
let allMessages = []; // Global array to store all loaded messages
let qrCodeData = null;
let timeFilter = {
    enabled: false,
    fromDate: null,
    toDate: null,
    fromTime: null,
    toTime: null
};
let hoursFilterEnabled = false;
let hoursFilterValue = 0;
let customerFilterEnabled = false;

// Message store for forwarding
let messageStore = {};

// Store for attached media files for forwarding
let attachedMedia = {};

// Function to download media for a specific message
async function downloadMessageMedia(messageId, chatId) {
  try {
    console.log(`Downloading media for message ${messageId} from chat ${chatId}`);
    
    const response = await fetch('/download-media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messageId: messageId,
        chatId: chatId
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      console.log('Media downloaded successfully:', data.mediaFilename);
      return data;
    } else {
      throw new Error(data.error || 'Failed to download media');
    }
  } catch (error) {
    console.error('Error downloading media:', error);
    showNotification(`Failed to download media: ${error.message}`, 'error');
    return null;
  }
}

// Function to download and display media on-demand
async function downloadAndDisplayMedia(messageId, sourcePhone) {
  try {
    showNotification('Downloading media...', 'info');
    
    // Format chatId from sourcePhone
    let chatId = sourcePhone;
    if (!sourcePhone.includes('@')) {
      // It's a phone number, format it properly
      let formattedNumber = sourcePhone;
      if (sourcePhone.startsWith('+')) {
        formattedNumber = sourcePhone.substring(1);
      }
      formattedNumber = formattedNumber.replace(/\D/g, '');
      chatId = `${formattedNumber}@c.us`;
    }
    
    const mediaData = await downloadMessageMedia(messageId, chatId);
    
    if (mediaData) {
      // Find the message element and update it with the downloaded media
      const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
      if (messageElement) {
        const mediaContainer = messageElement.querySelector('.media-container');
        if (mediaContainer) {
          // Update the media container with the downloaded media
          let mediaContent = '';
          if (mediaData.mediaMimetype.startsWith('image/')) {
            mediaContent = `
              <img src="${mediaData.mediaUrl}" alt="${mediaData.mediaFilename}" class="media-image" />
              <div class="media-info">📷 Image: ${mediaData.mediaFilename}</div>
            `;
          } else if (mediaData.mediaMimetype.startsWith('video/')) {
            mediaContent = `
              <video controls class="media-video">
                <source src="${mediaData.mediaUrl}" type="${mediaData.mediaMimetype}">
                Your browser does not support the video tag.
              </video>
              <div class="media-info">🎥 Video: ${mediaData.mediaFilename}</div>
            `;
          } else if (mediaData.mediaMimetype.startsWith('audio/')) {
            mediaContent = `
              <audio controls class="media-audio">
                <source src="${mediaData.mediaUrl}" type="${mediaData.mediaMimetype}">
                Your browser does not support the audio tag.
              </audio>
              <div class="media-info">🎵 Audio: ${mediaData.mediaFilename}</div>
            `;
          } else {
            mediaContent = `
              <div class="media-file">
                <i class="fas fa-file"></i>
                <a href="${mediaData.mediaUrl}" download="${mediaData.mediaFilename}" class="media-download">
                  📎 Download: ${mediaData.mediaFilename}
                </a>
              </div>
            `;
          }
          
          // Add action buttons
          mediaContent += `
            <div class="download-actions">
              <button onclick="downloadMedia('${mediaData.mediaUrl}', '${mediaData.mediaFilename}')" class="download-btn">
                <i class="fas fa-download"></i> Download
              </button>
              <button onclick="copyMediaLink('${mediaData.mediaUrl}')" class="copy-btn">
                <i class="fas fa-copy"></i> Copy Link
              </button>
              <button onclick="forwardMessageWithMedia('${messageId}', '${sourcePhone}')" class="forward-btn">
                <i class="fas fa-share"></i> Forward to Customers
              </button>
            </div>
          `;
          
          mediaContainer.innerHTML = mediaContent;
          
          // Store the media data for forwarding
          attachedMedia[messageId] = {
            mediaUrl: mediaData.mediaUrl,
            mediaFilename: mediaData.mediaFilename,
            mediaMimetype: mediaData.mediaMimetype,
            sourcePhone: sourcePhone
          };
        }
      }
      
      showNotification('Media downloaded successfully!', 'success');
    }
  } catch (error) {
    console.error('Error downloading and displaying media:', error);
    showNotification(`Failed to download media: ${error.message}`, 'error');
  }
}

// Function to forward a message with media to customers
async function forwardMessageWithMedia(messageId, sourcePhone) {
  try {
    // Check if we have the media data
    let mediaData = attachedMedia[messageId];
    
    if (!mediaData) {
      // Try to download the media first
      showNotification('Downloading media for forwarding...', 'info');
      
      let chatId = sourcePhone;
      if (!sourcePhone.includes('@')) {
        let formattedNumber = sourcePhone;
        if (sourcePhone.startsWith('+')) {
          formattedNumber = sourcePhone.substring(1);
        }
        formattedNumber = formattedNumber.replace(/\D/g, '');
        chatId = `${formattedNumber}@c.us`;
      }
      
      const downloadedMedia = await downloadMessageMedia(messageId, chatId);
      if (!downloadedMedia) {
        showNotification('Failed to download media for forwarding', 'error');
        return;
      }
      
      mediaData = {
        mediaUrl: downloadedMedia.mediaUrl,
        mediaFilename: downloadedMedia.mediaFilename,
        mediaMimetype: downloadedMedia.mediaMimetype,
        sourcePhone: sourcePhone
      };
      
      attachedMedia[messageId] = mediaData;
    }
    
    // Show customer groups for selection
    showCustomerGroupsForForwarding(mediaData);
    
  } catch (error) {
    console.error('Error forwarding message with media:', error);
    showNotification(`Failed to forward message: ${error.message}`, 'error');
  }
}

// Function to show customer groups for forwarding
function showCustomerGroupsForForwarding(mediaData) {
  // Switch to groups section
  showSection('groups');
  
  // Show a notification about the media being ready for forwarding
  showNotification(`Media ready for forwarding: ${mediaData.mediaFilename}`, 'success');
  
  // Store the media data globally for the forwarding process
  window.currentForwardingMedia = mediaData;
}

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    console.log('🔧 DOM Content Loaded - Initializing elements...');
    
    // Initialize filter elements
    textFilter = document.getElementById('textFilter');
    applyTextFilter = document.getElementById('applyTextFilter');
    clearTextFilter = document.getElementById('clearTextFilter');
    hoursFilter = document.getElementById('hoursFilter');
    applyHoursFilter = document.getElementById('applyHoursFilter');
    clearHoursFilter = document.getElementById('clearHoursFilter');
    applyCustomerFilter = document.getElementById('applyCustomerFilter');
    clearCustomerFilter = document.getElementById('clearCustomerFilter');
    
    // Initialize secret code monitoring elements
    secretCodeInput = document.getElementById('secretCodeInput');
    secretCodeGroupSelect = document.getElementById('secretCodeGroupSelect');
    secretCodeTimeRange = document.getElementById('secretCodeTimeRange');
    includeThumbsUp = document.getElementById('includeThumbsUp');
    // Auto monitor elements removed - using secret code search only
    secretCodeResults = document.getElementById('secretCodeResults');
    secretCodeList = document.getElementById('secretCodeList');
    totalCustomers = document.getElementById('totalCustomers');
    respondedCount = document.getElementById('respondedCount');
    notRespondedCount = document.getElementById('notRespondedCount');
    selectAllResponded = document.getElementById('selectAllResponded');
    selectAllNotResponded = document.getElementById('selectAllNotResponded');
    sendReminderBtn = document.getElementById('sendReminderBtn');
    fromDate = document.getElementById('fromDate');
    toDate = document.getElementById('toDate');
    fromTimeSlider = document.getElementById('fromTimeSlider');
    toTimeSlider = document.getElementById('toTimeSlider');
    fromTimeDisplay = document.getElementById('fromTimeDisplay');
    toTimeDisplay = document.getElementById('toTimeDisplay');
    applyTimeFilter = document.getElementById('applyTimeFilter');
    clearTimeFilter = document.getElementById('clearTimeFilter');
    resetTimeFilter = document.getElementById('resetTimeFilter');
    timeRangeSummary = document.getElementById('timeRangeSummary');
    summaryText = document.getElementById('summaryText');
    summaryDetails = document.getElementById('summaryDetails');
    presetButtons = document.querySelectorAll('.preset-btn');
    
    console.log('🔧 Elements initialized, setting up event listeners...');
    setupEventListeners();
    console.log('🔧 Event listeners set up, checking socket connection...');
    
    // Auto-load customer groups when app starts (with small delay to ensure socket is ready)
    console.log('🔧 Auto-loading customer groups...');
    setTimeout(() => {
        loadCustomerGroups();
        showNotification('Loading customer groups automatically...', 'info');
    }, 1000); // 1 second delay to ensure socket connection is established
    
    // Check socket connection status
    if (socket && socket.connected) {
        console.log('✅ Socket is connected');
    } else {
        console.log('❌ Socket is not connected');
    }
});

// Global error handler
window.addEventListener('error', function(event) {
    console.error('Global error:', event.error);
});

// Initial page load check
console.log('🚀 Page loaded, checking initial status...');
console.log('🔍 Socket status:', socket ? (socket.connected ? 'connected' : 'disconnected') : 'not initialized');

// Check DOM elements after they're loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('🔍 Current status text:', statusText ? statusText.textContent : 'statusText not found');
    console.log('🔍 Current status indicator:', statusIndicator ? statusIndicator.className : 'statusIndicator not found');
});

window.addEventListener('unhandledrejection', function(event) {
    console.error('Unhandled promise rejection:', event.reason);
    event.preventDefault();
});

function setupEventListeners() {
    addPhoneBtn.addEventListener('click', addPhoneNumber);
    setPhoneBtn.addEventListener('click', setPhoneNumbers);
    clearPhonesBtn.addEventListener('click', clearPhoneNumbers);
    saveListBtn.addEventListener('click', saveCurrentList);
    loadListBtn.addEventListener('click', showSavedLists);
    if (customerListBtn) {
        customerListBtn.addEventListener('click', showCustomerListModal);
    }
    loadChatsBtn.addEventListener('click', loadAllChats);
    showAllBtn.addEventListener('click', () => filterChats('all'));
    showContactsBtn.addEventListener('click', () => filterChats('contacts'));
    showGroupsBtn.addEventListener('click', () => filterChats('groups'));
    refreshBtn.addEventListener('click', refreshMessages);
    const copyTextBtn = document.getElementById('copyTextBtn');
    if (copyTextBtn) {
        copyTextBtn.addEventListener('click', copyMessagesText);
    }
    scrollToBottomBtn.addEventListener('click', scrollToBottom);
    
    // Load more messages button
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', loadMoreMessages);
    }
    
    // Secret code monitoring event listeners removed - using secret code search only
    if (selectAllResponded) {
        selectAllResponded.addEventListener('click', selectAllRespondedCustomers);
    }
    if (selectAllNotResponded) {
        selectAllNotResponded.addEventListener('click', selectAllNotRespondedCustomers);
    }
    if (sendReminderBtn) {
        sendReminderBtn.addEventListener('click', sendSecretCodeReminder);
    }
    
    // Navigation event listeners
    navBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const section = e.target.dataset.section;
            showSection(section);
        });
    });
    
    // Groups event listeners
    loadGroupsBtn.addEventListener('click', loadCustomerGroups);
    refreshGroupsBtn.addEventListener('click', loadCustomerGroups);
    backToGroupsBtn.addEventListener('click', () => showSection('groups'));
    sendGroupMessageBtn.addEventListener('click', sendGroupMessage);
    previewGroupBtn.addEventListener('click', previewGroupMessage);
    selectAllRecipientsBtn.addEventListener('click', selectAllRecipients);
    deselectAllRecipientsBtn.addEventListener('click', deselectAllRecipients);
    
    // Emoji quick buttons event listeners
    document.querySelectorAll('.emoji-btn').forEach(button => {
        button.addEventListener('click', function() {
            const emoji = this.getAttribute('data-emoji');
            const textarea = document.getElementById('groupMessageInput');
            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const newText = text.substring(0, start) + emoji + ' ' + text.substring(end);
                textarea.value = newText;
                // Move cursor after the emoji and space
                textarea.setSelectionRange(start + emoji.length + 1, start + emoji.length + 1);
                textarea.focus();
            }
        });
    });
    
    // Text filter event listeners
    if (applyTextFilter) {
        applyTextFilter.addEventListener('click', applyTextFilterToMessages);
    }
    if (clearTextFilter) {
        clearTextFilter.addEventListener('click', clearTextFilterFromMessages);
    }
    
    // Hours filter event listeners
    if (applyHoursFilter) {
        applyHoursFilter.addEventListener('click', applyHoursFilterToMessages);
    }
    if (clearHoursFilter) {
        clearHoursFilter.addEventListener('click', clearHoursFilterFromMessages);
    }
    
    // Customer filter event listeners
    if (applyCustomerFilter) {
        applyCustomerFilter.addEventListener('click', applyCustomerFilterToMessages);
    }
    if (clearCustomerFilter) {
        clearCustomerFilter.addEventListener('click', clearCustomerFilterFromMessages);
    }
    
    // Customer selector event listeners
    const customerSelector = document.getElementById('customerSelector');
    const applyCustomerSelector = document.getElementById('applyCustomerSelector');
    const clearCustomerSelector = document.getElementById('clearCustomerSelector');
    
    if (applyCustomerSelector) {
        applyCustomerSelector.addEventListener('click', applyCustomerSelectorFilter);
    }
    if (clearCustomerSelector) {
        clearCustomerSelector.addEventListener('click', clearCustomerSelectorFilter);
    }
    
    // Time filter event listeners
    if (fromTimeSlider) {
        fromTimeSlider.addEventListener('input', updateFromTimeDisplay);
    }
    if (toTimeSlider) {
        toTimeSlider.addEventListener('input', updateToTimeDisplay);
    }
    if (fromDate) {
        fromDate.addEventListener('change', function() {
            console.log('From date changed to:', this.value);
            // Auto-apply filter when date changes
            if (this.value && toDate && toDate.value) {
                applyTimeFilterToMessages();
            }
        });
    }
    if (toDate) {
        toDate.addEventListener('change', function() {
            console.log('To date changed to:', this.value);
            // Auto-apply filter when date changes
            if (this.value && fromDate && fromDate.value) {
                applyTimeFilterToMessages();
            }
        });
    }
    if (applyTimeFilter) {
        applyTimeFilter.addEventListener('click', applyTimeFilterToMessages);
    }
    if (clearTimeFilter) {
        clearTimeFilter.addEventListener('click', clearTimeFilterFromMessages);
    }
    if (resetTimeFilter) {
        resetTimeFilter.addEventListener('click', resetTimeFilterToDefault);
    }
    
    // Preset button event listeners
    if (presetButtons) {
        presetButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const preset = e.target.dataset.preset;
                applyTimePreset(preset);
            });
        });
    }
    phoneInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            addPhoneNumber();
        }
    });
    
    // Show/hide scroll button based on scroll position
    messagesContainer.addEventListener('scroll', function() {
        const isAtBottom = messagesContainer.scrollTop + messagesContainer.clientHeight >= messagesContainer.scrollHeight - 10;
        scrollToBottomBtn.style.display = isAtBottom ? 'none' : 'flex';
    });
    
    // Initialize time filter
    initializeTimeFilter();
}

// Socket.IO event listeners
socket.on('connect', function() {
    console.log('✅ Connected to server');
    statusText.textContent = 'Connected to server';
    statusIndicator.className = 'status-indicator connected';
});

socket.on('disconnect', function() {
    console.log('❌ Disconnected from server');
    updateStatus('disconnected', 'Disconnected from server');
});

socket.on('connect_error', function(error) {
    console.error('Connection error:', error);
    updateStatus('error', 'Connection failed');
});

socket.on('clientStatus', function(data) {
    console.log('Client status:', data);
    isConnected = data.isReady;
    currentPhoneNumber = data.targetPhone;
    
    if (data.isReady) {
        updateStatus('connected', 'WhatsApp Connected');
        qrSection.style.display = 'none';
        phoneSection.style.display = 'block';
        
        if (data.targetPhone) {
            targetPhoneDisplay.textContent = data.targetPhone;
            messagesSection.style.display = 'block';
            loadMessages(data.targetPhone);
        }
    } else {
        updateStatus('connecting', 'Connecting to WhatsApp...');
        qrSection.style.display = 'block';
        phoneSection.style.display = 'none';
        messagesSection.style.display = 'none';
    }
});

let qrCountdownInterval = null;

socket.on('qrCode', function(data) {
    console.log('📱 QR Code received');
    qrCodeData = data.qrImage; // Store QR code data
    displayQRCode(data.qrImage);
    updateStatus('connecting', 'Scan QR Code to connect');
    qrSection.style.display = 'block';
    phoneSection.style.display = 'none';
    messagesSection.style.display = 'none';
    
    // Show countdown warning
    const warningEl = document.getElementById('qrRefreshWarning');
    const countdownEl = document.getElementById('qrCountdown');
    if (warningEl && countdownEl) {
        warningEl.style.display = 'block';
        
        // Clear any existing countdown
        if (qrCountdownInterval) {
            clearInterval(qrCountdownInterval);
        }
        
        // Start countdown from 20 seconds
        let seconds = 20;
        countdownEl.textContent = seconds;
        
        qrCountdownInterval = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                countdownEl.textContent = 'Refreshing...';
                clearInterval(qrCountdownInterval);
                setTimeout(() => {
                    if (warningEl) warningEl.style.display = 'none';
                }, 1000);
            } else {
                countdownEl.textContent = seconds;
            }
        }, 1000);
    }
});

socket.on('clientReady', function(data) {
    console.log('✅ WhatsApp client ready');
    updateStatus('connected', 'WhatsApp Connected');
    qrSection.style.display = 'none';
    phoneSection.style.display = 'block';
    
    // Clear QR countdown
    if (qrCountdownInterval) {
        clearInterval(qrCountdownInterval);
        qrCountdownInterval = null;
    }
    const warningEl = document.getElementById('qrRefreshWarning');
    if (warningEl) {
        warningEl.style.display = 'none';
    }
    
    // Show success notification
    showNotification('WhatsApp connected successfully! ✓', 'success');
    
    // Show session note on Railway
    const sessionNote = document.getElementById('sessionNote');
    if (sessionNote && window.location.hostname !== 'localhost') {
        sessionNote.style.display = 'block';
        // Hide after 10 seconds
        setTimeout(() => {
            if (sessionNote) sessionNote.style.display = 'none';
        }, 10000);
    }
});

socket.on('authFailure', function(data) {
    console.error('Authentication failed:', data.message);
    showError('Authentication failed: ' + data.message);
});

socket.on('clientDisconnected', function(data) {
    console.log('Client disconnected:', data.reason);
    updateStatus('connecting', 'Reconnecting...');
    qrSection.style.display = 'block';
    phoneSection.style.display = 'none';
    messagesSection.style.display = 'none';
});

socket.on('newMessage', function(messageData) {
    console.log('New message received:', messageData);
    if (currentPhoneNumber && messageData.from.includes(currentPhoneNumber)) {
        addMessageToContainer(messageData);
    }
});

// Listen for message loading progress
socket.on('message-progress', function(data) {
    console.log(`Loading progress: ${data.current}/${data.total} - ${data.chatName || data.phoneNumber}`);
    updateLoadingProgress(data.current, data.total, data.chatName || data.phoneNumber);
});

function updateStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
    
    const icon = statusIndicator.querySelector('i');
    if (status === 'connected') {
        icon.className = 'fas fa-circle';
        icon.style.color = '#28a745';
    } else if (status === 'connecting') {
        icon.className = 'fas fa-spinner fa-spin';
        icon.style.color = '#ffc107';
    } else if (status === 'disconnected') {
        icon.className = 'fas fa-circle';
        icon.style.color = '#dc3545';
    }
}

function updateLoadingProgress(current, total, phoneNumber) {
    const loadingMessages = document.getElementById('loadingMessages');
    if (loadingMessages) {
        const progressText = loadingMessages.querySelector('.loading-text');
        if (progressText) {
            progressText.textContent = `Loading messages... ${current}/${total} (${phoneNumber})`;
        }
    }
}

function displayQRCode(qrImageData) {
    const qrCodeDiv = document.getElementById('qrCode');
    qrCodeDiv.innerHTML = `<img src="${qrImageData}" alt="QR Code" style="max-width: 300px; height: auto;">`;
}

function addPhoneNumber() {
    const phoneNumber = phoneInput.value.trim();
    
    if (!phoneNumber) {
        showError('Please enter a phone number');
        return;
    }
    
    // Basic validation - accept phone numbers starting with +, @c.us, or @g.us
    if (!phoneNumber.startsWith('+') && !phoneNumber.includes('@c.us') && !phoneNumber.includes('@g.us')) {
        showError('Phone number must be in format +1234567890, 1234567890@c.us, or 120363123456789012@g.us');
        return;
    }
    
    // Check if already added
    if (currentPhoneNumbers.includes(phoneNumber)) {
        showError('Phone number already added');
        return;
    }
    
    // Add to list
    currentPhoneNumbers.push(phoneNumber);
    phoneInput.value = '';
    updatePhoneList();
    updateSetPhoneButton();
    hideError();
}

function removePhoneNumber(phoneNumber) {
    currentPhoneNumbers = currentPhoneNumbers.filter(num => num !== phoneNumber);
    updatePhoneList();
    updateSetPhoneButton();
}

function clearPhoneNumbers() {
    currentPhoneNumbers = [];
    updatePhoneList();
    updateSetPhoneButton();
}

function updatePhoneList() {
    phoneList.innerHTML = '';
    currentPhoneNumbers.forEach(phoneNumber => {
        const phoneItem = document.createElement('div');
        phoneItem.className = 'phone-item';
        phoneItem.innerHTML = `
            <span class="phone-number">${phoneNumber}</span>
            <button class="remove-phone" onclick="removePhoneNumber('${phoneNumber}')">
                <i class="fas fa-times"></i>
            </button>
        `;
        phoneList.appendChild(phoneItem);
    });
}

function updateSetPhoneButton() {
    setPhoneBtn.disabled = currentPhoneNumbers.length === 0;
    saveListBtn.disabled = currentPhoneNumbers.length === 0;
    if (currentPhoneNumbers.length > 0) {
        targetPhoneDisplay.textContent = `(${currentPhoneNumbers.length} chats)`;
    }
}

function loadAllChats() {
    if (!isConnected) {
        showError('WhatsApp client not connected. Please scan QR code first.');
        return;
    }
    
    console.log('Loading all chats...');
    loadChatsBtn.disabled = true;
    loadChatsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    
    fetch('/chats')
    .then(response => response.json())
    .then(data => {
        if (data.chats) {
            allChats = data.chats;
            displayChats(allChats);
            chatList.style.display = 'block';
            console.log(`Loaded ${data.totalChats} chats (${data.groups.length} groups, ${data.contacts.length} contacts)`);
            hideError();
        } else {
            showError(data.error || 'Failed to load chats');
        }
    })
    .catch(error => {
        console.error('Error loading chats:', error);
        showError('Failed to load chats: ' + error.message);
    })
    .finally(() => {
        loadChatsBtn.disabled = false;
        loadChatsBtn.innerHTML = '<i class="fas fa-list"></i> Load All Chats';
    });
}

function displayChats(chats) {
    chatList.innerHTML = '';
    
    chats.forEach(chat => {
        const chatItem = document.createElement('div');
        chatItem.className = `chat-item ${chat.isGroup ? 'group' : 'contact'}`;
        
        const lastMessage = chat.lastMessage ? 
            `${new Date(chat.lastMessage.timestamp * 1000).toLocaleString()}: ${chat.lastMessage.body.substring(0, 50)}${chat.lastMessage.body.length > 50 ? '...' : ''}` : 
            'No recent messages';
        
        chatItem.innerHTML = `
            <div class="chat-info">
                <div class="chat-name">
                    <i class="fas ${chat.isGroup ? 'fa-users' : 'fa-user'}"></i>
                    ${chat.name}
                    ${chat.isGroup ? '<span class="group-badge">GROUP</span>' : ''}
                </div>
                <div class="chat-last-message">${lastMessage}</div>
                <div class="chat-id">ID: ${chat.id}</div>
            </div>
            <button class="add-chat-btn" onclick="addChatToSelection('${chat.id}', '${chat.name.replace(/'/g, "\\'")}')">
                <i class="fas fa-plus"></i>
            </button>
        `;
        
        chatList.appendChild(chatItem);
    });
}

function filterChats(filter) {
    currentFilter = filter;
    
    // Update filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    if (filter === 'all') showAllBtn.classList.add('active');
    else if (filter === 'contacts') showContactsBtn.classList.add('active');
    else if (filter === 'groups') showGroupsBtn.classList.add('active');
    
    let filteredChats = allChats;
    if (filter === 'contacts') {
        filteredChats = allChats.filter(chat => !chat.isGroup);
    } else if (filter === 'groups') {
        filteredChats = allChats.filter(chat => chat.isGroup);
    }
    
    displayChats(filteredChats);
}

function addChatToSelection(chatId, chatName) {
    if (currentPhoneNumbers.includes(chatId)) {
        showError('Chat already added');
        return;
    }
    
    currentPhoneNumbers.push(chatId);
    updatePhoneList();
    updateSetPhoneButton();
    hideError();
    
    showNotification(`Added ${chatName}`, 'success');
}

function setPhoneNumbers() {
    if (currentPhoneNumbers.length === 0) {
        showError('Please add at least one phone number');
        return;
    }
    
    if (!isConnected) {
        showError('WhatsApp client not connected. Please scan QR code first.');
        return;
    }
    
    console.log('Setting phone numbers:', currentPhoneNumbers);
    
    // Send phone numbers to server
    fetch('/set-phone', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phoneNumbers: currentPhoneNumbers })
    })
    .then(response => response.json())
    .then(data => {
        console.log('Set phones response:', data);
        if (data.success) {
            if (data.clientReady) {
                phoneSection.style.display = 'none';
                messagesSection.style.display = 'block';
                loadMergedMessages();
                hideError();
            } else {
                showError('WhatsApp client not ready. Please wait and try again.');
            }
        } else {
            showError(data.error || 'Failed to set phone numbers');
        }
    })
    .catch(error => {
        console.error('Error setting phone numbers:', error);
        showError('Failed to set phone numbers: ' + error.message);
    });
}

function loadMessages(phoneNumber) {
    loadingMessages.style.display = 'block';
    messagesContainer.innerHTML = '';
    messagesContainer.appendChild(loadingMessages);
    
    console.log('Loading messages for:', phoneNumber);
    
    fetch(`/messages/${encodeURIComponent(phoneNumber)}`)
    .then(response => {
        console.log('Response status:', response.status);
        return response.json();
    })
    .then(data => {
        console.log('Response data:', data);
        loadingMessages.style.display = 'none';
        
        if (data.error) {
            showError(`Error: ${data.error}${data.details ? ' - ' + data.details : ''}`);
            return;
        }
        
        if (data.messages && data.messages.length > 0) {
            displayMessages(data.messages);
        } else {
            messagesContainer.innerHTML = '<div class="no-messages">No messages found for this phone number.</div>';
        }
    })
    .catch(error => {
        console.error('Error loading messages:', error);
        loadingMessages.style.display = 'none';
        showError('Failed to load messages: ' + error.message);
    });
}

function loadMergedMessages() {
    loadingMessages.style.display = 'block';
    messagesContainer.innerHTML = '';
    messagesContainer.appendChild(loadingMessages);
    
    console.log('Loading merged messages for:', currentPhoneNumbers);
    console.log('Time filter enabled:', timeFilter.enabled, 'Hours filter enabled:', hoursFilterEnabled, 'Value:', hoursFilterValue);
    
    // Build query parameters based on active filters
    let queryParams = new URLSearchParams();
    if (hoursFilterEnabled && hoursFilterValue > 0) {
        queryParams.append('hours', hoursFilterValue);
        console.log('Sending hours filter:', hoursFilterValue);
    } else if (timeFilter.enabled) {
        queryParams.append('datetimeFilter', 'true');
        // Send actual from/to timestamps for precise filtering
        if (timeFilter.fromDate && timeFilter.toDate) {
            queryParams.append('from', timeFilter.fromDate.getTime());
            queryParams.append('to', timeFilter.toDate.getTime());
            console.log('Sending datetime filter, from:', new Date(timeFilter.fromDate).toLocaleString(), 'to:', new Date(timeFilter.toDate).toLocaleString());
        } else {
            queryParams.append('days', 1); // Default to today
            console.log('Sending datetime filter, default days: 1');
        }
    }
    
    const queryString = queryParams.toString();
    const url = '/messages-merged' + (queryString ? '?' + queryString : '');
    
    console.log('Fetching merged messages for selected phone numbers:', currentPhoneNumbers);
    
    // Use POST to send currentPhoneNumbers to get messages ONLY from selected list
    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phoneNumbers: currentPhoneNumbers })
    })
    .then(response => {
        console.log('Response status:', response.status);
        return response.json();
    })
    .then(data => {
        console.log('Response data:', data);
        loadingMessages.style.display = 'none';
        
        if (data.error) {
            showError(`Error: ${data.error}${data.details ? ' - ' + data.details : ''}`);
            return;
        }
        
        if (data.messages && data.messages.length > 0) {
            // Store messages globally
            allMessages = data.messages;
            
            displayMessages(data.messages);
            populateCustomerSelector(); // Populate dropdown with senders from loaded messages
            
            console.log(`Loaded ${data.totalMessages} unique messages from ${data.phoneNumbers ? data.phoneNumbers.length : 0} phone numbers`);
        } else {
            messagesContainer.innerHTML = '<div class="no-messages">No messages found for the selected phone numbers.</div>';
            allMessages = []; // Reset messages array
            populateCustomerSelector(); // Update dropdown
        }
    })
    .catch(error => {
        console.error('Error loading merged messages:', error);
        loadingMessages.style.display = 'none';
        showError('Failed to load merged messages: ' + error.message);
    });
}

function displayMessages(messages) {
    console.log('displayMessages called with', messages.length, 'messages');
    console.log('timeFilter.enabled:', timeFilter.enabled);
    console.log('timeFilter.fromDate:', timeFilter.fromDate);
    console.log('timeFilter.toDate:', timeFilter.toDate);
    
    messagesContainer.innerHTML = '';
    
    // Sort messages by timestamp (oldest first)
    messages.sort((a, b) => a.timestamp - b.timestamp);
    
    let displayedCount = 0;
    
    // Apply time filter if enabled, otherwise show all messages
    if (timeFilter.enabled && timeFilter.fromDate && timeFilter.toDate) {
        console.log('Applying time filter from', timeFilter.fromDate, 'to', timeFilter.toDate);
        // Apply custom time filter
        messages.forEach(message => {
            const messageDate = new Date(message.timestamp * 1000);
            if (messageDate >= timeFilter.fromDate && messageDate <= timeFilter.toDate) {
                addMessageToContainer(message);
                displayedCount++;
            }
        });
    } else {
        console.log('No time filter applied, showing all messages');
        // Show all messages if no time filter is applied
        messages.forEach(message => {
            addMessageToContainer(message);
            displayedCount++;
        });
    }
    
    console.log('Displayed', displayedCount, 'messages out of', messages.length, 'total');
    
    // Show load more button and message count info
    if (loadMoreContainer && messageCountInfo) {
        loadMoreContainer.style.display = 'block';
        messageCountInfo.innerHTML = `Showing <span class="count">${displayedCount}</span> recent messages (last 5 per contact)`;
    }
    
    // Scroll to bottom after all messages are loaded
    setTimeout(() => {
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 200);
}

function copyMessagesText() {
    const messagesContainer = document.getElementById('messagesContainer');
    if (!messagesContainer) {
        showNotification('No messages to copy', 'error');
        return;
    }
    
    const messages = messagesContainer.querySelectorAll('.message');
    if (messages.length === 0) {
        showNotification('No messages to copy', 'error');
        return;
    }
    
    let textToCopy = '';
    
    messages.forEach((messageDiv) => {
        const messageHeader = messageDiv.querySelector('.message-header');
        const messageBody = messageDiv.querySelector('.message-body');
        
        if (messageHeader && messageBody) {
            const senderName = messageHeader.querySelector('.message-from')?.textContent.trim() || 'Unknown';
            const timestamp = messageHeader.querySelector('.message-time')?.textContent.trim() || '';
            
            // Get text content only, excluding media and buttons
            const bodyText = messageBody.textContent.trim();
            
            // Format: [Timestamp] Sender: Message
            textToCopy += `[${timestamp}] ${senderName}: ${bodyText}\n`;
        }
    });
    
    // Copy to clipboard
    navigator.clipboard.writeText(textToCopy).then(() => {
        showNotification('Messages copied to clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy text:', err);
        showNotification('Failed to copy text to clipboard', 'error');
    });
}

function addMessageToContainer(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.isFromMe ? 'from-me' : 'from-them'}`;
    
    const timestamp = new Date(message.timestamp * 1000);
    const timeString = timestamp.toLocaleString();
    
    let mediaContent = '';
    if (message.hasMedia) {
        if (message.mediaUrl) {
            // Media is already downloaded
            if (message.mediaMimetype.startsWith('image/')) {
                mediaContent = `<div class="media-container">
                    <img src="${message.mediaUrl}" alt="${message.mediaFilename}" class="media-image" />
                    <div class="media-info">📷 Image: ${message.mediaFilename}</div>
                </div>`;
            } else if (message.mediaMimetype.startsWith('video/')) {
                mediaContent = `<div class="media-container">
                    <video controls class="media-video">
                        <source src="${message.mediaUrl}" type="${message.mediaMimetype}">
                        Your browser does not support the video tag.
                    </video>
                    <div class="media-info">🎥 Video: ${message.mediaFilename}</div>
                </div>`;
            } else if (message.mediaMimetype.startsWith('audio/')) {
                mediaContent = `<div class="media-container">
                    <audio controls class="media-audio">
                        <source src="${message.mediaUrl}" type="${message.mediaMimetype}">
                        Your browser does not support the audio tag.
                    </audio>
                    <div class="media-info">🎵 Audio: ${message.mediaFilename}</div>
                </div>`;
            } else {
                mediaContent = `<div class="media-container">
                    <div class="media-file">
                        <i class="fas fa-file"></i>
                        <a href="${message.mediaUrl}" download="${message.mediaFilename}" class="media-download">
                            📎 Download: ${message.mediaFilename}
                        </a>
                    </div>
                </div>`;
            }
            
            // Add action buttons for downloaded media
            mediaContent += `<div class="download-actions">
                <button onclick="downloadMedia('${message.mediaUrl}', '${message.mediaFilename}')" class="download-btn">
                    <i class="fas fa-download"></i> Download
                </button>
                <button onclick="copyMediaLink('${message.mediaUrl}')" class="copy-btn">
                    <i class="fas fa-copy"></i> Copy Link
                </button>
                <button onclick="forwardMessageWithMedia('${message.id}', '${message.sourcePhone || message.from}')" class="forward-btn">
                    <i class="fas fa-share"></i> Forward to Customers
                </button>
            </div>`;
        } else if (message.mediaNote) {
            // Media needs to be downloaded on-demand
            mediaContent = `<div class="media-container">
                <div class="media-placeholder">
                    <i class="fas fa-file"></i>
                    <div class="media-info">📎 ${message.mediaNote}</div>
                    <button onclick="downloadAndDisplayMedia('${message.id}', '${message.sourcePhone || message.from}')" class="download-media-btn">
                        <i class="fas fa-download"></i> Download Media
                    </button>
                </div>
            </div>`;
        } else if (message.mediaError) {
            mediaContent = `<div class="media-error">❌ ${message.mediaError}</div>`;
        }
    }
    
    // Determine sender display name
    let senderDisplay = message.isFromMe ? 'You' : (message.senderName || 'Unknown');
    
    // Add chat name for context if it's different from sender
    let chatContext = '';
    if (message.chatName && message.chatName !== message.senderName && !message.isFromMe) {
      chatContext = ` <span class="chat-context">(from ${message.chatName})</span>`;
    }
    
    // Check if sender is from customer groups (for marking attendance)
    let markAttendanceBtn = '';
    if (!message.isFromMe && message.senderPhone && message.senderPhone !== 'Me') {
        // Extract phone number from senderPhone (remove @c.us or @g.us)
        const customerPhone = message.senderPhone.replace('@c.us', '').replace('@g.us', '');
        markAttendanceBtn = `
            <button class="btn-mark-attendance" data-customer-phone="${customerPhone}" data-message-timestamp="${message.timestamp}">
                <i class="fas fa-check-circle"></i> Mark Present
            </button>
        `;
    }
    
    messageDiv.setAttribute('data-message-id', message.id);
    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="message-from">${senderDisplay}${chatContext}</span>
            <span class="message-time">${timeString}</span>
        </div>
        <div class="message-body">
            ${message.body ? escapeHtml(message.body) : ''}
            ${mediaContent}
        </div>
        <div class="message-actions">
            <button class="btn-forward" data-message-id="${message.id}">
                <i class="fas fa-share"></i> Forward
            </button>
            ${markAttendanceBtn}
        </div>
    `;
    
    // Store message for forwarding
    messageStore[message.id] = message;
    
    messagesContainer.appendChild(messageDiv);
    
    // Add forward button event listener
    const forwardBtn = messageDiv.querySelector('.btn-forward');
    if (forwardBtn) {
        forwardBtn.addEventListener('click', function() {
            const messageId = this.getAttribute('data-message-id');
            const message = messageStore[messageId];
            if (message) {
                forwardMessage(messageId, message);
            }
        });
    }
    
    // Add mark attendance button event listener
    const markAttendanceBtnElement = messageDiv.querySelector('.btn-mark-attendance');
    if (markAttendanceBtnElement) {
        markAttendanceBtnElement.addEventListener('click', function() {
            const customerPhone = this.getAttribute('data-customer-phone');
            const messageTimestamp = this.getAttribute('data-message-timestamp');
            markAttendanceFromMessage(customerPhone, messageTimestamp);
        });
    }
    
    // Smooth scroll to bottom
    setTimeout(() => {
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 100);
}

function refreshMessages() {
    if (currentPhoneNumbers.length > 0) {
        loadMergedMessages();
    } else if (currentPhoneNumber) {
        loadMessages(currentPhoneNumber);
    }
}

function scrollToBottom() {
    messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: 'smooth'
    });
}

function showError(message) {
    errorText.textContent = message;
    errorMessage.style.display = 'flex';
}

function hideError() {
    errorMessage.style.display = 'none';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Download media function
function downloadMedia(mediaUrl, filename) {
    try {
        const link = document.createElement('a');
        link.href = mediaUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Show success message
        showNotification(`Downloading ${filename}...`, 'success');
    } catch (error) {
        console.error('Download error:', error);
        showNotification('Download failed', 'error');
    }
}

// Copy media link function
function copyMediaLink(mediaUrl) {
    try {
        navigator.clipboard.writeText(mediaUrl).then(() => {
            showNotification('Media link copied to clipboard!', 'success');
        }).catch(() => {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = mediaUrl;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            showNotification('Media link copied to clipboard!', 'success');
        });
    } catch (error) {
        console.error('Copy error:', error);
        showNotification('Failed to copy link', 'error');
    }
}

// Attach media for forwarding
function attachMediaForForward(messageId) {
    const message = messageStore[messageId];
    if (!message) {
        showNotification('Message not found', 'error');
        return;
    }
    
    if (!message.hasMedia || !message.mediaUrl) {
        showNotification('No media to attach', 'error');
        return;
    }
    
    // Store the media for forwarding
    attachedMedia[messageId] = {
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaMimetype,
        mediaFilename: message.mediaFilename,
        hasMedia: message.hasMedia
    };
    
    // Update the button to show it's attached
    const attachBtn = document.querySelector(`button[onclick="attachMediaForForward('${messageId}')"]`);
    if (attachBtn) {
        attachBtn.innerHTML = '<i class="fas fa-check"></i> Attached';
        attachBtn.style.backgroundColor = '#28a745';
        attachBtn.style.color = 'white';
    }
    
    showNotification(`Media "${message.mediaFilename}" attached for forwarding`, 'success');
}

// Remove attached media
function removeAttachedMedia(messageId) {
    if (attachedMedia[messageId]) {
        delete attachedMedia[messageId];
        
        // Update the button to show it's not attached
        const attachBtn = document.querySelector(`button[onclick="attachMediaForForward('${messageId}')"]`);
        if (attachBtn) {
            attachBtn.innerHTML = '<i class="fas fa-paperclip"></i> Attach for Forward';
            attachBtn.style.backgroundColor = '';
            attachBtn.style.color = '';
        }
        
        showNotification('Media attachment removed', 'info');
    }
}

// Show notification function
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

// Save/Load functionality
function saveCurrentList() {
    if (currentPhoneNumbers.length === 0) {
        showNotification('No contacts/groups selected to save', 'error');
        return;
    }
    
    const listName = prompt('Enter a name for this list:');
    if (!listName || listName.trim() === '') {
        showNotification('List name cannot be empty', 'error');
        return;
    }
    
    const savedLists = getSavedLists();
    savedLists[listName.trim()] = {
        phoneNumbers: [...currentPhoneNumbers],
        timestamp: new Date().toISOString(),
        count: currentPhoneNumbers.length
    };
    
    localStorage.setItem('whatsapp_saved_lists', JSON.stringify(savedLists));
    showNotification(`List "${listName}" saved successfully!`, 'success');
}

function showSavedLists() {
    const savedLists = getSavedLists();
    const listNames = Object.keys(savedLists);
    
    if (listNames.length === 0) {
        showNotification('No saved lists found', 'info');
        return;
    }
    
    // Create modal for list selection
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Load Saved List</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="saved-lists">
                    ${listNames.map(name => {
                        const list = savedLists[name];
                        const date = new Date(list.timestamp).toLocaleDateString();
                        return `
                            <div class="saved-list-item" data-name="${name}">
                                <div class="list-info">
                                    <strong>${name}</strong>
                                    <span class="list-count">${list.count} items</span>
                                    <span class="list-date">${date}</span>
                                </div>
                                <div class="list-actions">
                                    <button class="btn btn-primary btn-sm load-list-btn" data-name="${name}">Load</button>
                                    <button class="btn btn-danger btn-sm delete-list-btn" data-name="${name}">Delete</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners for modal
    modal.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
    
    // Load list button
    modal.querySelectorAll('.load-list-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const listName = e.target.dataset.name;
            loadSavedList(listName);
            document.body.removeChild(modal);
        });
    });
    
    // Delete list button
    modal.querySelectorAll('.delete-list-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const listName = e.target.dataset.name;
            if (confirm(`Are you sure you want to delete "${listName}"?`)) {
                deleteSavedList(listName);
                document.body.removeChild(modal);
                showSavedLists(); // Refresh the modal
            }
        });
    });
}

function loadSavedList(listName) {
    const savedLists = getSavedLists();
    const list = savedLists[listName];
    
    if (!list) {
        showNotification('List not found', 'error');
        return;
    }
    
    // Clear current selection
    currentPhoneNumbers = [];
    
    // Load the saved list
    currentPhoneNumbers = [...list.phoneNumbers];
    
    // Update UI
    updatePhoneList();
    updateSetPhoneButton();
    
    showNotification(`Loaded "${listName}" with ${list.count} items`, 'success');
}

function deleteSavedList(listName) {
    const savedLists = getSavedLists();
    delete savedLists[listName];
    localStorage.setItem('whatsapp_saved_lists', JSON.stringify(savedLists));
    showNotification(`List "${listName}" deleted`, 'success');
}

function getSavedLists() {
    try {
        const saved = localStorage.getItem('whatsapp_saved_lists');
        return saved ? JSON.parse(saved) : {};
    } catch (error) {
        console.error('Error loading saved lists:', error);
        return {};
    }
}

// Navigation and Section Management
function showSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.status-card, .qr-section, .phone-section, .messages-section, .groups-section, .group-message-section, .secret-code-section, .manual-secret-code-section').forEach(section => {
        section.style.display = 'none';
    });
    
    // Update navigation buttons
    navBtns.forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.section === sectionName) {
            btn.classList.add('active');
        }
    });
    
    // Show selected section
    switch(sectionName) {
        case 'status':
            document.getElementById('statusCard').style.display = 'block';
            if (qrCodeData) {
                document.getElementById('qrSection').style.display = 'block';
            }
            break;
        case 'messages':
            document.getElementById('phoneSection').style.display = 'block';
            if (currentPhoneNumbers.length > 0) {
                document.getElementById('messagesSection').style.display = 'block';
            }
            break;
        case 'groups':
            groupsSection.style.display = 'block';
            if (Object.keys(currentGroups).length === 0) {
                loadCustomerGroups();
            }
            break;
        case 'secretCode':
            document.getElementById('secretCodeSection').style.display = 'block';
            // Load groups for secret code monitoring if not already loaded
            if (Object.keys(currentGroups).length === 0) {
                loadCustomerGroups();
            }
            break;
        case 'secretCode':
            document.getElementById('secretCodeSection').style.display = 'block';
            // Load groups for secret code search if not already loaded
            if (Object.keys(currentGroups).length === 0) {
                loadCustomerGroups();
            }
            break;
    }
}

// Customer Groups Management
async function loadCustomerGroups() {
    try {
        loadingGroups.style.display = 'block';
        groupsContainer.innerHTML = '';
        
        const response = await fetch('/groups/load');
        const data = await response.json();
        
        if (data.success) {
            currentGroups = data.groups;
            displayGroups(currentGroups);
            showNotification(`Loaded ${data.totalGroups} customer groups`, 'success');
        } else {
            showNotification('Failed to load groups: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error loading groups:', error);
        showNotification('Error loading customer groups', 'error');
    } finally {
        loadingGroups.style.display = 'none';
    }
}

function displayGroups(groups) {
    groupsContainer.innerHTML = '';
    
    if (Object.keys(groups).length === 0) {
        groupsContainer.innerHTML = `
            <div class="no-groups">
                <i class="fas fa-users"></i>
                <h3>No Customer Groups Found</h3>
                <p>Click "Load from Google Sheets" to import your customer groups.</p>
            </div>
        `;
        return;
    }
    
    Object.values(groups).forEach(group => {
        const groupCard = document.createElement('div');
        groupCard.className = 'group-card';
        groupCard.innerHTML = `
            <div class="group-header">
                <h3 class="group-name">${group.name}</h3>
                <span class="group-count">${group.totalCustomers}</span>
            </div>
            <div class="group-info">
                <div class="group-info-item">
                    <span>Customers:</span>
                    <span>${group.totalCustomers}</span>
                </div>
                <div class="group-info-item">
                    <span>Last Updated:</span>
                    <span>${new Date(group.lastUpdated).toLocaleDateString()}</span>
                </div>
            </div>
            <div class="group-actions">
                <button class="btn btn-primary" onclick="viewGroupDetails('${group.name}')">
                    <i class="fas fa-eye"></i> View
                </button>
                <button class="btn btn-success" onclick="sendMessageToGroup('${group.name}')">
                    <i class="fas fa-paper-plane"></i> Send Message
                </button>
                <button class="btn btn-info" onclick="checkAbsentees('${group.name}')">
                    <i class="fas fa-user-times"></i> Check Absentees
                </button>
            </div>
        `;
        groupsContainer.appendChild(groupCard);
    });
    
    // Update secret code group select
    updateSecretCodeGroupSelect();
}

// Update secret code group select dropdown
function updateSecretCodeGroupSelect() {
    if (!secretCodeGroupSelect) return;
    
    // Clear existing options
    secretCodeGroupSelect.innerHTML = '<option value="">Select a group...</option>';
    
    // Add groups to select
    Object.values(currentGroups).forEach(group => {
        const option = document.createElement('option');
        option.value = group.name;
        option.textContent = group.name;
        secretCodeGroupSelect.appendChild(option);
    });
}

// Function to check if message contains secret code with relaxed matching
function containsSecretCode(messageBody, secretCode, includeThumbsUpFlag) {
    if (!messageBody || !secretCode) return false;
    
    const message = messageBody.toLowerCase().trim();
    const code = secretCode.toLowerCase().trim();
    
    // If includeThumbsUp is checked, add thumbs up variations
    let searchPatterns = [code];
    
    if (includeThumbsUpFlag) {
        // Add various thumbs up combinations
        searchPatterns.push(
            `👍${code}`,
            `👍 ${code}`,
            `${code}👍`,
            `${code} 👍`,
            `👍${code}👍`,
            `👍 ${code} 👍`
        );
    }
    
    // Check for exact matches first
    for (const pattern of searchPatterns) {
        if (message.includes(pattern)) {
            return true;
        }
    }
    
    // Relaxed matching - remove spaces and special characters for more flexible matching
    const cleanMessage = message.replace(/[^\w👍]/g, '');
    const cleanCode = code.replace(/[^\w]/g, '');
    
    // Check if the clean code appears anywhere in the clean message
    if (cleanMessage.includes(cleanCode)) {
        return true;
    }
    
    // Check for partial matches with thumbs up
    if (includeThumbsUpFlag) {
        // Look for thumbs up followed by any part of the code
        const thumbsUpIndex = cleanMessage.indexOf('👍');
        if (thumbsUpIndex !== -1) {
            const afterThumbsUp = cleanMessage.substring(thumbsUpIndex + 1);
            if (afterThumbsUp.includes(cleanCode) || cleanCode.includes(afterThumbsUp)) {
                return true;
            }
        }
        
        // Look for code followed by thumbs up
        const codeIndex = cleanMessage.indexOf(cleanCode);
        if (codeIndex !== -1) {
            const afterCode = cleanMessage.substring(codeIndex + cleanCode.length);
            if (afterCode.includes('👍')) {
                return true;
            }
        }
    }
    
    return false;
}

// Function to highlight secret code in message text
function highlightSecretCode(messageBody, secretCode, includeThumbsUpFlag) {
    if (!messageBody || !secretCode) return messageBody;
    
    const message = messageBody;
    const code = secretCode.toLowerCase();
    
    // Create patterns to match
    let patterns = [code];
    
    if (includeThumbsUpFlag) {
        patterns.push(
            `👍${code}`,
            `👍 ${code}`,
            `${code}👍`,
            `${code} 👍`,
            `👍${code}👍`,
            `👍 ${code} 👍`
        );
    }
    
    let highlightedMessage = message;
    
    // Highlight each pattern
    patterns.forEach(pattern => {
        const regex = new RegExp(`(${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        highlightedMessage = highlightedMessage.replace(regex, '<span class="highlighted-code">$1</span>');
    });
    
    return highlightedMessage;
}

// Function removed - no longer using collapsible view

function viewGroupDetails(groupName) {
    const group = currentGroups[groupName];
    if (!group) return;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>${group.name} - Customer Details</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="group-details">
                    <div class="group-stats">
                        <div class="stat-item">
                            <div class="stat-number">${group.totalCustomers}</div>
                            <div class="stat-label">Total Customers</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-number">${new Date(group.lastUpdated).toLocaleDateString()}</div>
                            <div class="stat-label">Last Updated</div>
                        </div>
                    </div>
                    <div class="customers-list">
                        <h4>Customers:</h4>
                        <div class="customers-container">
                            ${group.customers.map(customer => `
                                <div class="customer-item">
                                    <div class="customer-info">
                                        <strong>${customer.name}</strong>
                                        <span class="customer-phone">${customer.phone}</span>
                                    </div>
                                    <div class="customer-actions">
                                        <button class="btn btn-sm btn-info" onclick="markAttendance('${groupName}', '${customer.phone}', 'present')">
                                            <i class="fas fa-check"></i> Present
                                        </button>
                                        <button class="btn btn-sm btn-warning" onclick="markAttendance('${groupName}', '${customer.phone}', 'absent')">
                                            <i class="fas fa-times"></i> Absent
                                        </button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

function sendMessageToGroup(groupName) {
    selectedGroup = groupName;
    
    // Load group details to populate recipients list
    if (currentGroups[groupName]) {
        const group = currentGroups[groupName];
        displayGroupRecipients(group);
    }
    
    showSection('group-message');
    groupMessageSection.style.display = 'block';
}

function displayGroupRecipients(group) {
    recipientsList.innerHTML = '';
    
    group.customers.forEach(customer => {
        const recipientItem = document.createElement('div');
        recipientItem.className = 'recipient-item selected';
        recipientItem.innerHTML = `
            <input type="checkbox" id="recipient-${customer.phone}" value="${customer.phone}" checked>
            <div class="recipient-info">
                <span class="recipient-name">${customer.name}</span>
                <span class="recipient-phone">${customer.phone}</span>
            </div>
        `;
        
        // Add click handler to toggle selection state
        const checkbox = recipientItem.querySelector('input[type="checkbox"]');
        const itemDiv = recipientItem;
        
        checkbox.addEventListener('change', () => {
            updateRecipientSelection(checkbox, itemDiv);
            updateRecipientCount();
        });
        
        itemDiv.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                updateRecipientSelection(checkbox, itemDiv);
                updateRecipientCount();
            }
        });
        
        recipientsList.appendChild(recipientItem);
    });
    
    // Initialize count
    updateRecipientCount();
    
    console.log(`Displayed ${group.customers.length} recipients for group: ${group.name}`);
}

function updateRecipientSelection(checkbox, itemDiv) {
    if (checkbox.checked) {
        itemDiv.classList.add('selected');
    } else {
        itemDiv.classList.remove('selected');
    }
}

function updateRecipientCount() {
    const countBadge = document.getElementById('recipientCountBadge');
    if (countBadge) {
        const totalCheckboxes = recipientsList.querySelectorAll('input[type="checkbox"]').length;
        const checkedCheckboxes = recipientsList.querySelectorAll('input[type="checkbox"]:checked').length;
        countBadge.textContent = `${checkedCheckboxes} of ${totalCheckboxes} selected`;
    }
}

function selectAllRecipients() {
    const checkboxes = recipientsList.querySelectorAll('input[type="checkbox"]');
    const recipientItems = recipientsList.querySelectorAll('.recipient-item');
    
    checkboxes.forEach((checkbox, index) => {
        checkbox.checked = true;
        recipientItems[index].classList.add('selected');
    });
    
    updateRecipientCount();
}

function deselectAllRecipients() {
    const checkboxes = recipientsList.querySelectorAll('input[type="checkbox"]');
    const recipientItems = recipientsList.querySelectorAll('.recipient-item');
    
    checkboxes.forEach((checkbox, index) => {
        checkbox.checked = false;
        recipientItems[index].classList.remove('selected');
    });
    
    updateRecipientCount();
}

async function sendGroupMessage() {
    if (!selectedGroup) {
        showNotification('No group selected', 'error');
        return;
    }
    
    const message = groupMessageInput.value.trim();
    const mediaUrl = groupMediaInput.value.trim();
    
    if (!message && !mediaUrl) {
        showNotification('Please enter a message or media URL', 'error');
        return;
    }
    
    // Collect selected recipients
    const selectedCheckboxes = recipientsList.querySelectorAll('input[type="checkbox"]:checked');
    const selectedPhones = Array.from(selectedCheckboxes).map(cb => cb.value);
    
    if (selectedPhones.length === 0) {
        showNotification('Please select at least one recipient', 'error');
        return;
    }
    
    try {
        sendGroupMessageBtn.disabled = true;
        sendGroupMessageBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
        
        const response = await fetch(`/groups/${selectedGroup}/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: message,
                mediaUrl: mediaUrl,
                selectedPhones: selectedPhones
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayGroupMessageResults(data);
            showNotification(`Message sent to ${data.successCount} out of ${selectedPhones.length} selected recipients`, 'success');
        } else {
            showNotification('Failed to send group message: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error sending group message:', error);
        showNotification('Error sending group message', 'error');
    } finally {
        sendGroupMessageBtn.disabled = false;
        sendGroupMessageBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send to Selected';
    }
}

function displayGroupMessageResults(data) {
    groupMessageResults.style.display = 'block';
    groupMessageResults.innerHTML = `
        <div class="result-summary">
            <h4>Message Results for ${data.groupName}</h4>
            <div class="result-stats">
                <div class="stat-item">
                    <div class="stat-number">${data.successCount}</div>
                    <div class="stat-label">Sent</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${data.errorCount}</div>
                    <div class="stat-label">Failed</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${data.totalCustomers}</div>
                    <div class="stat-label">Total</div>
                </div>
            </div>
        </div>
        <div class="result-list">
            ${data.results.map(result => `
                <div class="result-item ${result.status === 'sent' ? 'success' : 'error'}">
                    <div class="result-customer">
                        <div class="result-customer-name">${result.name}</div>
                        <div class="result-customer-phone">${result.phone}</div>
                    </div>
                    <div class="result-status ${result.status}">
                        ${result.status === 'sent' ? 'Sent' : 'Failed'}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function previewGroupMessage() {
    const message = groupMessageInput.value.trim();
    const mediaUrl = groupMediaInput.value.trim();
    
    if (!message && !mediaUrl) {
        showNotification('Please enter a message or media URL to preview', 'error');
        return;
    }
    
    const preview = document.createElement('div');
    preview.className = 'modal-overlay';
    preview.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Message Preview</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="message-preview">
                    ${mediaUrl ? `<img src="${mediaUrl}" style="max-width: 100%; height: auto; margin-bottom: 10px;" alt="Media preview">` : ''}
                    <div class="message-text">${message || 'No text message'}</div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(preview);
    
    preview.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(preview);
    });
    
    preview.addEventListener('click', (e) => {
        if (e.target === preview) {
            document.body.removeChild(preview);
        }
    });
}

async function markAttendance(groupName, customerPhone, status) {
    try {
        const response = await fetch(`/groups/${groupName}/attendance`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                customerPhone: customerPhone,
                status: status
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Marked ${status} for customer`, 'success');
        } else {
            showNotification('Failed to update attendance: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error updating attendance:', error);
        showNotification('Error updating attendance', 'error');
    }
}

// Check absentees for a group
async function checkAbsentees(groupName) {
    try {
        const response = await fetch(`/groups/${groupName}/absentees`);
        const data = await response.json();
        
        if (!data.success) {
            showNotification('Failed to fetch absentees: ' + data.error, 'error');
            return;
        }
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 800px;">
                <div class="modal-header">
                    <h3>Absent Customers - ${groupName}</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="absentees-stats">
                        <div class="stat-item">
                            <div class="stat-number">${data.presentCount}</div>
                            <div class="stat-label">Present</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-number">${data.absentCount}</div>
                            <div class="stat-label">Absent</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-number">${data.totalCustomers}</div>
                            <div class="stat-label">Total</div>
                        </div>
                    </div>
                    ${data.absentCount > 0 ? `
                        <div class="absentees-list" style="margin-top: 20px;">
                            <h4>Absent Customers:</h4>
                            <div style="margin-bottom: 10px;">
                                <button class="btn btn-sm" onclick="selectAllAbsentees()" style="margin-right: 10px;">
                                    <i class="fas fa-check-square"></i> Select All
                                </button>
                                <button class="btn btn-sm" onclick="deselectAllAbsentees()">
                                    <i class="fas fa-square"></i> Deselect All
                                </button>
                            </div>
                            <div style="max-height: 300px; overflow-y: auto;">
                                ${data.absentCustomers.map((customer, index) => `
                                    <div style="padding: 10px; border-bottom: 1px solid #eee; display: flex; align-items: center;">
                                        <input type="checkbox" id="absentee_${index}" class="absentee-checkbox" checked data-phone="${customer.phone}" data-name="${customer.name}" style="margin-right: 10px; width: 18px; height: 18px;">
                                        <label for="absentee_${index}" style="flex: 1; cursor: pointer;">
                                            <strong>${customer.name}</strong>
                                            <div style="color: #666; font-size: 0.9em;">${customer.phone}</div>
                                        </label>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <div class="followup-section" style="margin-top: 20px;">
                            <h4>Send Follow-up Message to Selected Absentees:</h4>
                            <textarea id="followupMessage" placeholder="Enter follow-up message..." style="width: 100%; min-height: 100px; padding: 10px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 4px; font-family: inherit;"></textarea>
                            <button class="btn btn-warning" onclick="sendFollowupToAbsentees('${groupName}')" style="width: 100%;">
                                <i class="fas fa-paper-plane"></i> Send Follow-up to Selected Absentees
                            </button>
                        </div>
                    ` : `
                        <div style="text-align: center; padding: 40px; color: #28a745;">
                            <i class="fas fa-check-circle" style="font-size: 3em; margin-bottom: 10px;"></i>
                            <h3>All Present!</h3>
                            <p>All customers have marked their attendance for today.</p>
                        </div>
                    `}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        modal.querySelector('.modal-close').addEventListener('click', () => {
            document.body.removeChild(modal);
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });
        
    } catch (error) {
        console.error('Error checking absentees:', error);
        showNotification('Error checking absentees', 'error');
    }
}

// Select all absentees
function selectAllAbsentees() {
    const checkboxes = document.querySelectorAll('.absentee-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = true;
    });
    showNotification(`Selected ${checkboxes.length} absentees`, 'success');
}

// Deselect all absentees
function deselectAllAbsentees() {
    const checkboxes = document.querySelectorAll('.absentee-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
    showNotification('Deselected all absentees', 'success');
}

// Send follow-up message to selected absentees
async function sendFollowupToAbsentees(groupName) {
    const messageInput = document.getElementById('followupMessage');
    const message = messageInput.value.trim();
    
    if (!message) {
        showNotification('Please enter a follow-up message', 'error');
        return;
    }
    
    // Get selected absentees
    const selectedCheckboxes = document.querySelectorAll('.absentee-checkbox:checked');
    
    if (selectedCheckboxes.length === 0) {
        showNotification('Please select at least one absentee to send the follow-up message', 'error');
        return;
    }
    
    // Collect selected phone numbers
    const selectedPhones = Array.from(selectedCheckboxes).map(checkbox => 
        checkbox.getAttribute('data-phone')
    );
    
    try {
        const response = await fetch(`/groups/${groupName}/followup`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: message,
                selectedPhones: selectedPhones
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Follow-up sent to ${data.successCount} out of ${selectedPhones.length} selected absentees`, 'success');
            
            // Close the modal
            const modal = document.querySelector('.modal-overlay');
            if (modal) {
                document.body.removeChild(modal);
            }
        } else {
            showNotification('Failed to send follow-up: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error sending follow-up:', error);
        showNotification('Error sending follow-up', 'error');
    }
}

// Apply text filter to messages
function applyTextFilterToMessages() {
    try {
        if (!textFilter) {
            console.error('Text filter element not found');
            showNotification('Text filter not available', 'error');
            return;
        }
        
        const filterText = textFilter.value.trim();
        
        if (!filterText) {
            showNotification('Please enter text to filter by', 'error');
            return;
        }
        
        // Store filter settings
        textFilterEnabled = true;
        textFilterPattern = filterText.toLowerCase();
        
        // Filter and display messages
        filterMessagesByText();
        
        showNotification(`Filtering messages containing: "${filterText}"`, 'success');
    } catch (error) {
        console.error('Error applying text filter:', error);
        showNotification('Error applying text filter', 'error');
    }
}

// Clear text filter
function clearTextFilterFromMessages() {
    try {
        if (!textFilter) {
            console.error('Text filter element not found');
            showNotification('Text filter not available', 'error');
            return;
        }
        
        textFilterEnabled = false;
        textFilterPattern = '';
        textFilter.value = '';
        
        // Show all messages
        const messageElements = messagesContainer.querySelectorAll('.message');
        messageElements.forEach(messageElement => {
            messageElement.style.display = 'block';
        });
        
        showNotification('Text filter cleared', 'success');
    } catch (error) {
        console.error('Error clearing text filter:', error);
        showNotification('Error clearing text filter', 'error');
    }
}

// Filter messages by text content
function filterMessagesByText() {
    try {
        if (!textFilterEnabled) {
            // Text filter cleared - reapply other active filters
            applyAllActiveFilters();
            return;
        }
        
        const messageElements = messagesContainer.querySelectorAll('.message');
        let visibleCount = 0;
        let hiddenCount = 0;
        
        messageElements.forEach(messageElement => {
            const messageTextElement = messageElement.querySelector('.message-text');
            const messageBody = messageTextElement ? messageTextElement.textContent.toLowerCase() : '';
            
            // Get current display status to preserve other filters
            const currentDisplay = messageElement.style.display;
            
            if (currentDisplay !== 'none') {
                if (messageBody.includes(textFilterPattern)) {
                    messageElement.style.display = 'block';
                    visibleCount++;
                } else {
                    messageElement.style.display = 'none';
                    hiddenCount++;
                }
            }
        });
        
        showNotification(`Showing ${visibleCount} messages containing "${textFilterPattern}" (${hiddenCount} hidden)`, 'info');
    } catch (error) {
        console.error('Error filtering messages by text:', error);
        showNotification('Error filtering messages by text', 'error');
    }
}

// Apply hours filter to messages
function applyHoursFilterToMessages() {
    try {
        if (!hoursFilter) {
            console.error('Hours filter element not found');
            showNotification('Hours filter not available', 'error');
            return;
        }
        
        const hours = parseInt(hoursFilter.value);
        
        if (!hours || hours < 1 || hours > 168) {
            showNotification('Please enter a valid number of hours (1-168)', 'error');
            return;
        }
        
        // Store filter settings
        hoursFilterEnabled = true;
        hoursFilterValue = hours;
        
        // Filter and display messages
        filterMessagesByHours();
        
        showNotification(`Filtering messages from the last ${hours} hours`, 'success');
    } catch (error) {
        console.error('Error applying hours filter:', error);
        showNotification('Error applying hours filter', 'error');
    }
}

// Clear hours filter
function clearHoursFilterFromMessages() {
    try {
        if (!hoursFilter) {
            console.error('Hours filter element not found');
            showNotification('Hours filter not available', 'error');
            return;
        }
        
        hoursFilterEnabled = false;
        hoursFilterValue = 0;
        hoursFilter.value = '';
        
        // Show all messages
        const messageElements = messagesContainer.querySelectorAll('.message');
        messageElements.forEach(messageElement => {
            messageElement.style.display = 'block';
        });
        
        showNotification('Hours filter cleared', 'success');
    } catch (error) {
        console.error('Error clearing hours filter:', error);
        showNotification('Error clearing hours filter', 'error');
    }
}

// Filter messages by hours
function filterMessagesByHours() {
    if (!hoursFilterEnabled) {
        // Hours filter cleared - reapply other active filters
        applyAllActiveFilters();
        return;
    }
    
    const messageElements = messagesContainer.querySelectorAll('.message');
    let visibleCount = 0;
    let hiddenCount = 0;
    const cutoffTime = new Date(Date.now() - (hoursFilterValue * 60 * 60 * 1000));
    
    messageElements.forEach(messageElement => {
        const messageTimeElement = messageElement.querySelector('.message-time');
        const messageTime = messageTimeElement ? messageTimeElement.textContent : '';
        
        // Parse message time and check if it's within the last X hours
        const messageDate = parseMessageTimestamp(messageTime);
        
        // Get current display status to preserve other filters
        const currentDisplay = messageElement.style.display;
        
        if (currentDisplay !== 'none') {
            if (messageDate && messageDate >= cutoffTime) {
                messageElement.style.display = 'block';
                visibleCount++;
            } else {
                messageElement.style.display = 'none';
                hiddenCount++;
            }
        }
    });
    
    showNotification(`Showing ${visibleCount} messages from the last ${hoursFilterValue} hours (${hiddenCount} hidden)`, 'info');
}

// Apply customer filter to messages
function applyCustomerFilterToMessages() {
    try {
        customerFilterEnabled = true;
        
        // Filter and display messages
        filterMessagesByCustomer();
        
        showNotification('Showing only customer messages', 'success');
    } catch (error) {
        console.error('Error applying customer filter:', error);
        showNotification('Error applying customer filter', 'error');
    }
}

// Clear customer filter
function clearCustomerFilterFromMessages() {
    try {
        customerFilterEnabled = false;
        
        // Reapply other active filters
        applyAllActiveFilters();
        
        showNotification('Customer filter cleared', 'success');
    } catch (error) {
        console.error('Error clearing customer filter:', error);
        showNotification('Error clearing customer filter', 'error');
    }
}

// Populate customer selector dropdown from loaded messages
function populateCustomerSelector() {
    const customerSelector = document.getElementById('customerSelector');
    if (!customerSelector) return;
    
    // Clear existing options
    customerSelector.innerHTML = '<option value="">-- All Customers --</option>';
    
    // Collect unique senders from loaded messages
    const senderMap = new Map();
    
    if (allMessages && allMessages.length > 0) {
        allMessages.forEach(msg => {
            if (msg.senderPhone && !msg.isFromMe) {
                const senderPhone = msg.senderPhone;
                const senderName = msg.customerName || msg.senderName || senderPhone;
                
                // Only add if not already added
                if (!senderMap.has(senderPhone)) {
                    senderMap.set(senderPhone, senderName);
                }
            }
        });
    }
    
    // Add options to dropdown sorted by name
    const sortedSenders = Array.from(senderMap.entries()).sort((a, b) => 
        a[1].localeCompare(b[1])
    );
    
    sortedSenders.forEach(([phone, name]) => {
        const option = document.createElement('option');
        option.value = phone;
        option.textContent = `${name} (${phone})`;
        customerSelector.appendChild(option);
    });
    
    console.log(`Populated customer selector with ${senderMap.size} senders from loaded messages`);
}

// Apply customer selector filter
function applyCustomerSelectorFilter() {
    const customerSelector = document.getElementById('customerSelector');
    if (!customerSelector) return;
    
    const selectedPhone = customerSelector.value;
    
    if (!selectedPhone) {
        showNotification('Please select a customer', 'error');
        return;
    }
    
    selectedCustomerPhone = selectedPhone;
    console.log('Filtering by customer:', selectedPhone);
    
    // Filter and display messages
    filterMessagesByCustomerSelector();
    
    showNotification(`Filtering messages for selected customer`, 'success');
}

// Clear customer selector filter
function clearCustomerSelectorFilter() {
    selectedCustomerPhone = null;
    
    const customerSelector = document.getElementById('customerSelector');
    if (customerSelector) {
        customerSelector.value = '';
    }
    
    // Reapply all active filters
    applyAllActiveFilters();
    
    showNotification('Customer selector filter cleared', 'success');
}

// Filter messages by selected customer
function filterMessagesByCustomerSelector() {
    if (!selectedCustomerPhone) {
        applyAllActiveFilters();
        return;
    }
    
    messagesContainer.innerHTML = '';
    
    // Get all filtered messages based on existing filters
    let filteredMessages = allMessages;
    
    // Apply other filters first
    if (customerFilterEnabled) {
        filteredMessages = filteredMessages.filter(msg => {
            const isIncoming = !msg.fromMe;
            return isIncoming;
        });
    }
    
    // Apply customer selector filter
    filteredMessages = filteredMessages.filter(msg => {
        if (msg.senderPhone) {
            const senderPhoneClean = msg.senderPhone.replace(/\D/g, '');
            const selectedPhoneClean = selectedCustomerPhone.replace(/\D/g, '');
            return senderPhoneClean === selectedPhoneClean;
        }
        return false;
    });
    
    // Display filtered messages
    displayMessages(filteredMessages);
}

// Filter messages by customer (hide your own messages)
function filterMessagesByCustomer() {
    if (!customerFilterEnabled) {
        // Clear customer filter - show all messages that match other active filters
        applyAllActiveFilters();
        return;
    }
    
    // If customer selector is active, filter by both
    if (selectedCustomerPhone) {
        filterMessagesByCustomerSelector();
        return;
    }
    
    const messageElements = messagesContainer.querySelectorAll('.message');
    let visibleCount = 0;
    let hiddenCount = 0;
    
    messageElements.forEach(messageElement => {
        const messageHeaderElement = messageElement.querySelector('.message-header');
        if (!messageHeaderElement) {
            // Don't change display - let other filters handle it
            return;
        }
        
        const senderElement = messageHeaderElement.querySelector('.message-from');
        const senderName = senderElement ? senderElement.textContent : '';
        
        // Check if message is from a customer (not from you)
        const isFromCustomer = !senderName.includes('You') && 
                               !senderName.includes('Me') && 
                               senderName.trim() !== '';
        
        // Get current display status (to preserve other filter states)
        const currentDisplay = messageElement.style.display;
        
        // Only hide if currently visible and not from customer
        if (currentDisplay !== 'none') {
            if (isFromCustomer) {
                // Keep visible if it matches customer filter
                messageElement.style.display = 'block';
                visibleCount++;
            } else {
                // Hide if not from customer
                messageElement.style.display = 'none';
                hiddenCount++;
            }
        }
    });
    
    showNotification(`Showing ${visibleCount} customer messages (${hiddenCount} hidden)`, 'info');
}

// Apply all active filters in sequence
function applyAllActiveFilters() {
    const messageElements = messagesContainer.querySelectorAll('.message');
    
    // First, show all messages
    messageElements.forEach(messageElement => {
        messageElement.style.display = 'block';
    });
    
    // Apply time filter if enabled
    if (timeFilter.enabled) {
        filterMessagesByTime();
    }
    
    // Apply hours filter if enabled
    if (hoursFilterEnabled) {
        filterMessagesByHours();
    }
    
    // Apply text filter if enabled
    if (textFilterEnabled) {
        filterMessagesByText();
    }
    
    // Apply customer filter if enabled (last, so it can hide messages already filtered)
    if (customerFilterEnabled) {
        filterMessagesByCustomer();
    }
}

// Initialize time filter with current date
function initializeTimeFilter() {
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + 
                    String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(today.getDate()).padStart(2, '0');
    
    fromDate.value = todayStr;
    toDate.value = todayStr;
    
    // Set default times (4:00 AM to 6:30 AM)
    fromTimeSlider.value = 240; // 4:00 AM = 4 * 60 = 240 minutes
    toTimeSlider.value = 390;   // 6:30 AM = 6 * 60 + 30 = 390 minutes
    
    updateFromTimeDisplay();
    updateToTimeDisplay();
    updateTimeRangeSummary();
    
    // Make sure time filter is disabled by default
    timeFilter.enabled = false;
}

// Update time display for from slider
function updateFromTimeDisplay() {
    const minutes = parseInt(fromTimeSlider.value);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    fromTimeDisplay.textContent = timeStr;
    updateTimeRangeSummary();
}

// Update time display for to slider
function updateToTimeDisplay() {
    const minutes = parseInt(toTimeSlider.value);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    toTimeDisplay.textContent = timeStr;
    updateTimeRangeSummary();
}

// These functions are now defined above in the enhanced section

// Filter messages by time range
function filterMessagesByTime() {
    if (!timeFilter.enabled) {
        // Time filter cleared - reapply other active filters
        applyAllActiveFilters();
        return;
    }
    
    const messageElements = messagesContainer.querySelectorAll('.message');
    let visibleCount = 0;
    let hiddenCount = 0;
    
    messageElements.forEach(messageElement => {
        const timestampElement = messageElement.querySelector('.message-time');
        if (!timestampElement) return;
        
        const timestampText = timestampElement.textContent;
        const messageDate = parseMessageTimestamp(timestampText);
        
        // Get current display status to preserve other filters
        const currentDisplay = messageElement.style.display;
        
        if (currentDisplay !== 'none') {
            if (messageDate && messageDate >= timeFilter.fromDate && messageDate <= timeFilter.toDate) {
                messageElement.style.display = 'block';
                visibleCount++;
            } else {
                messageElement.style.display = 'none';
                hiddenCount++;
            }
        }
    });
    
    showNotification(`Showing ${visibleCount} messages (${hiddenCount} hidden by filter)`, 'info');
}

// Parse message timestamp
function parseMessageTimestamp(timestampText) {
    try {
        // Handle different timestamp formats
        // Format: "Dec 25, 2023, 2:30:45 PM" or "25/12/2023, 14:30:45"
        const date = new Date(timestampText);
        if (isNaN(date.getTime())) {
            return null;
        }
        return date;
    } catch (error) {
        console.error('Error parsing timestamp:', error);
        return null;
    }
}

// Message forwarding functionality
function forwardMessage(messageId, message) {
    if (!message) {
        showNotification('Message not found', 'error');
        return;
    }
    
    // Create forward dialog
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Forward Message</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="forward-preview">
                    <h4>Message Preview:</h4>
                    <div class="message-preview">
                        <div class="preview-sender">From: ${message.senderName || 'Unknown'}</div>
                        <div class="preview-time">Time: ${new Date(message.timestamp * 1000).toLocaleString()}</div>
                        <div class="preview-body">${message.body || 'No text content'}</div>
                        ${message.hasMedia ? `<div class="preview-media">📎 Media: ${message.mediaFilename || 'Media file'}</div>` : ''}
                    </div>
                </div>
                <div class="attached-media" id="attachedMediaPreview" style="display: none;">
                    <h4>Attached Media:</h4>
                    <div id="attachedMediaList"></div>
                </div>
                <div class="forward-groups">
                    <h4>Select Groups to Forward To:</h4>
                    <div class="group-selection">
                        ${Object.keys(currentGroups).map(groupName => `
                            <label class="checkbox-label">
                                <input type="checkbox" value="${groupName}" class="group-checkbox">
                                ${groupName} (${currentGroups[groupName].totalCustomers} customers)
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="forward-actions">
                    <button class="btn btn-primary" onclick="executeForward('${messageId}', this)">
                        <i class="fas fa-paper-plane"></i> Forward Message
                    </button>
                    <button class="btn btn-secondary modal-close">
                        <i class="fas fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

async function executeForward(messageId, button) {
    const selectedGroups = Array.from(document.querySelectorAll('.group-checkbox:checked')).map(cb => cb.value);
    
    if (selectedGroups.length === 0) {
        showNotification('Please select at least one group', 'error');
        return;
    }
    
    const message = messageStore[messageId];
    if (!message) {
        showNotification('Message not found', 'error');
        return;
    }
    
    // Disable button and show loading
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Forwarding...';
    
    // Check if media needs to be downloaded
    let mediaUrl = message.mediaUrl || '';
    let mediaType = message.mediaMimetype || '';
    let mediaFilename = message.mediaFilename || '';
    
    if (message.hasMedia && !message.mediaUrl) {
        // Media hasn't been downloaded yet, try to get it from attachedMedia
        const attached = attachedMedia[messageId];
        if (attached) {
            mediaUrl = attached.mediaUrl;
            mediaType = attached.mediaMimetype;
            mediaFilename = attached.mediaFilename;
        } else {
            // Need to download the media first
            showNotification('Downloading media for forwarding...', 'info');
            try {
                const chatId = message.sourcePhone || message.from;
                const downloadedMedia = await downloadMessageMedia(messageId, chatId);
                if (downloadedMedia) {
                    mediaUrl = downloadedMedia.mediaUrl;
                    mediaType = downloadedMedia.mediaMimetype;
                    mediaFilename = downloadedMedia.mediaFilename;
                    
                    // Store in attachedMedia for future use
                    attachedMedia[messageId] = {
                        mediaUrl: downloadedMedia.mediaUrl,
                        mediaFilename: downloadedMedia.mediaFilename,
                        mediaMimetype: downloadedMedia.mediaMimetype,
                        sourcePhone: chatId
                    };
                    
                    // Also update messageStore
                    message.mediaUrl = downloadedMedia.mediaUrl;
                    message.mediaMimetype = downloadedMedia.mediaMimetype;
                    message.mediaFilename = downloadedMedia.mediaFilename;
                } else {
                    showNotification('Failed to download media. Sending text only.', 'warning');
                    mediaUrl = '';
                    mediaType = '';
                    mediaFilename = '';
                }
            } catch (error) {
                console.error('Error downloading media:', error);
                showNotification('Failed to download media. Sending text only.', 'warning');
                mediaUrl = '';
                mediaType = '';
                mediaFilename = '';
            }
        }
    }
    
    // Forward to each selected group
    let completed = 0;
    let total = selectedGroups.length;
    
    selectedGroups.forEach(async (groupName) => {
        try {
            const response = await fetch(`/groups/${groupName}/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: message.body || '',
                    mediaUrl: mediaUrl,
                    mediaType: mediaType,
                    mediaFilename: mediaFilename,
                    hasMedia: message.hasMedia && mediaUrl && mediaType
                })
            });
            
            const data = await response.json();
            completed++;
            
            if (completed === total) {
                // Close modal and show results
                document.querySelector('.modal-overlay').remove();
                showNotification(`Message forwarded to ${completed} groups`, 'success');
            }
        } catch (error) {
            console.error('Error forwarding to group:', groupName, error);
            completed++;
            
            if (completed === total) {
                document.querySelector('.modal-overlay').remove();
                showNotification(`Message forwarded to ${completed} groups (some may have failed)`, 'warning');
            }
        }
    });
}

// Step 1: Select customer group
async function showCustomerListModal() {
    try {
        console.log('Customer List button clicked');
        console.log('Current groups loaded:', Object.keys(currentGroups).length);
        
        // Check if we have groups loaded
        if (Object.keys(currentGroups).length === 0) {
            showNotification('No customer groups loaded. Please load groups first.', 'warning');
            return;
        }
        
        // Create modal for group selection
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>Select Customer Group</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom: 15px;">Choose a group to load messages from:</p>
                    <div class="group-list" style="max-height: 500px; overflow-y: auto;">
                        ${Object.keys(currentGroups).map(groupName => {
                            const group = currentGroups[groupName];
                            const groupId = groupName.replace(/[^a-zA-Z0-9]/g, '_');
                            return `
                                <div class="group-item" onclick="selectCustomerGroup('${groupName}')" 
                                     style="padding: 15px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; cursor: pointer; transition: background 0.2s;"
                                     onmouseover="this.style.background='#f5f5f5'"
                                     onmouseout="this.style.background='white'">
                                    <h5 style="margin: 0 0 5px 0;">${groupName}</h5>
                                    <p style="margin: 0; color: #666; font-size: 0.9em;">${group.totalCustomers} customers</p>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd;">
                        <button class="btn btn-secondary modal-close">
                            <i class="fas fa-times"></i> Cancel
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Event listeners
        modal.querySelector('.modal-close').addEventListener('click', () => {
            document.body.removeChild(modal);
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });
        
    } catch (error) {
        console.error('Error loading customer list:', error);
        showNotification('Error loading customer list', 'error');
    }
}

// Step 2: Show customers from selected group
function selectCustomerGroup(groupName) {
    const group = currentGroups[groupName];
    
    // Close the group selection modal
    const groupModal = document.querySelector('.modal-overlay');
    if (groupModal) {
        document.body.removeChild(groupModal);
    }
    
    // Create modal for customer selection
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 700px;">
            <div class="modal-header">
                <h3>Select Customers from ${groupName}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="customer-list-info">
                    <p><strong>Group:</strong> ${groupName} (${group.totalCustomers} customers)</p>
                    <div class="customer-list-controls" style="margin: 15px 0;">
                        <button class="btn btn-sm btn-primary" onclick="selectAllCustomers()" style="margin-right: 10px;">
                            Select All
                        </button>
                        <button class="btn btn-sm btn-secondary" onclick="deselectAllCustomers()" style="margin-right: 10px;">
                            Deselect All
                        </button>
                        <button class="btn btn-sm btn-success" onclick="loadSelectedMessages()" style="margin-right: 10px;">
                            <i class="fas fa-search"></i> Load Selected Messages
                        </button>
                    </div>
                </div>
                <div class="customer-list">
                    <div class="customer-phone-list" style="max-height: 400px; overflow-y: auto;">
                        ${group.customers.map((customer, index) => {
                            const customerId = `customer_${index}`;
                            return `
                                <div class="customer-phone-item" style="padding: 8px 0; border-bottom: 1px solid #eee;">
                                    <input type="checkbox" id="${customerId}" 
                                           class="customer-checkbox" 
                                           style="margin-right: 10px;" checked>
                                    <label for="${customerId}" style="cursor: pointer;">
                                        <strong>${customer.name}</strong><br>
                                        <span style="color: #666; font-size: 0.9em;">${customer.phone}</span>
                                    </label>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
                <div class="customer-list-actions" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd;">
                    <button class="btn btn-primary" onclick="loadSelectedMessages()">
                        <i class="fas fa-search"></i> Load Selected Messages
                    </button>
                    <button class="btn btn-secondary modal-close" style="margin-left: 10px;">
                        <i class="fas fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Store modal reference for loadCustomerMessages
    window.customerListModal = modal;
    
    // Event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(modal);
        window.customerListModal = null;
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
            window.customerListModal = null;
        }
    });
}

// Load combined messages from selected customers only (Messages modal)
async function loadSelectedMessages() {
    try {
        // Get selected customer phone numbers and names
        const allPhoneNumbers = [];
        const customerNames = [];
        const selectedCheckboxes = document.querySelectorAll('.customer-checkbox:checked');
        
        if (selectedCheckboxes.length === 0) {
            showNotification('Please select at least one customer', 'warning');
            return;
        }
        
        selectedCheckboxes.forEach((checkbox) => {
            const label = checkbox.nextElementSibling;
            if (label) {
                // Get customer name from the label (strong tag)
                const nameTag = label.querySelector('strong');
                const customerName = nameTag ? nameTag.textContent.trim() : '';
                
                // Find the span with the phone number (it's now in a separate span)
                const phoneSpan = label.querySelector('span');
                if (phoneSpan) {
                    const phoneText = phoneSpan.textContent.trim();
                    let phoneNumber = phoneText.replace(/[^0-9]/g, ''); // Remove non-numeric
                    if (!phoneNumber.endsWith('@c.us')) {
                        phoneNumber = phoneNumber + '@c.us';
                    }
                    allPhoneNumbers.push(phoneNumber);
                    customerNames.push(customerName || phoneNumber);
                }
            }
        });
        
        if (allPhoneNumbers.length === 0) {
            showNotification('No valid phone numbers found in selected customers', 'error');
            return;
        }
        
        // Close modal
        if (window.customerListModal) {
            document.body.removeChild(window.customerListModal);
            window.customerListModal = null;
        }
        
        // Show loading notification with customer names
        let notificationText = `Loading messages from ${customerNames.length} selected customer${customerNames.length > 1 ? 's' : ''}...`;
        if (customerNames.length <= 3) {
            notificationText = `Loading messages from: ${customerNames.join(', ')}...`;
        } else {
            notificationText = `Loading messages from: ${customerNames.slice(0, 3).join(', ')} and ${customerNames.length - 3} more...`;
        }
        showNotification(notificationText, 'info');
        
        // Set phone numbers and load messages
        currentPhoneNumbers = [...new Set(allPhoneNumbers)]; // Remove duplicates
        updatePhoneList();
        updateSetPhoneButton();
        
        // Load messages
        if (isConnected) {
            await setPhoneNumbers();
        } else {
            showNotification('WhatsApp not connected. Please wait for connection.', 'warning');
        }
        
    } catch (error) {
        console.error('Error loading customer messages:', error);
        showNotification('Error loading customer messages', 'error');
    }
}

// Select all customers
function selectAllCustomers() {
    const checkboxes = document.querySelectorAll('.customer-checkbox');
    checkboxes.forEach(cb => cb.checked = true);
}

// Deselect all customers
function deselectAllCustomers() {
    const checkboxes = document.querySelectorAll('.customer-checkbox');
    checkboxes.forEach(cb => cb.checked = false);
}

// Mark attendance from a message
async function markAttendanceFromMessage(customerPhone, messageTimestamp) {
    try {
        // Find which group this customer belongs to
        let foundGroup = null;
        
        Object.keys(currentGroups).forEach(groupName => {
            const group = currentGroups[groupName];
            if (group.customers && Array.isArray(group.customers)) {
                const customer = group.customers.find(c => {
                    // Remove non-digits for comparison
                    const cleanCustomerPhone = c.phone.replace(/\D/g, '');
                    const cleanMessagePhone = customerPhone.replace(/\D/g, '');
                    return cleanCustomerPhone === cleanMessagePhone;
                });
                if (customer) {
                    foundGroup = groupName;
                }
            }
        });
        
        if (!foundGroup) {
            showNotification('Customer not found in any group', 'error');
            return;
        }
        
        // Use current month (YYYY-MM format)
        const currentMonth = new Date().toISOString().slice(0, 7);
        
        // Call the attendance endpoint
        const response = await fetch(`/groups/${foundGroup}/attendance`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                customerPhone: customerPhone,
                status: 'present',
                month: currentMonth
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Attendance marked for customer (month: ${currentMonth})`, 'success');
        } else {
            showNotification('Failed to mark attendance: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error marking attendance:', error);
        showNotification('Error marking attendance', 'error');
    }
}

// Enhanced Time Filter Functions

// Apply time preset
function applyTimePreset(preset) {
    const now = new Date();
    let fromDateTime, toDateTime;
    const dayOfWeek = now.getDay();
    
    // Clear any active preset
    presetButtons.forEach(btn => btn.classList.remove('active'));
    
    switch(preset) {
        case 'today':
            fromDateTime = new Date(now);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setHours(23, 59, 59, 999);
            console.log('Today preset - fromDateTime:', fromDateTime, 'toDateTime:', toDateTime);
            break;
            
        case 'yesterday':
            fromDateTime = new Date(now);
            fromDateTime.setDate(now.getDate() - 1);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setDate(now.getDate() - 1);
            toDateTime.setHours(23, 59, 59, 999);
            break;
            
        case 'last7days':
            fromDateTime = new Date(now);
            fromDateTime.setDate(now.getDate() - 7);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setHours(23, 59, 59, 999);
            break;
            
        case 'last30days':
            fromDateTime = new Date(now);
            fromDateTime.setDate(now.getDate() - 30);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setHours(23, 59, 59, 999);
            break;
            
        case 'thisweek':
            fromDateTime = new Date(now);
            fromDateTime.setDate(now.getDate() - dayOfWeek);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setHours(23, 59, 59, 999);
            break;
            
        case 'lastweek':
            // Calculate last week as Sunday to Saturday (7 days ago)
            fromDateTime = new Date(now);
            fromDateTime.setDate(now.getDate() - dayOfWeek - 7);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setDate(now.getDate() - dayOfWeek - 1);
            toDateTime.setHours(23, 59, 59, 999);
            console.log('Last week preset - fromDateTime:', fromDateTime, 'toDateTime:', toDateTime);
            break;
            
        case 'thismonth':
            fromDateTime = new Date(now.getFullYear(), now.getMonth(), 1);
            fromDateTime.setHours(0, 0, 0, 0);
            toDateTime = new Date(now);
            toDateTime.setHours(23, 59, 59, 999);
            break;
            
        case 'custom':
            // Don't change anything, just mark as active
            document.querySelector('[data-preset="custom"]').classList.add('active');
            updateTimeRangeSummary();
            return;
            
        default:
            return;
    }
    
    // Update form fields - use local date formatting to avoid timezone issues
    const fromDateStr = fromDateTime.getFullYear() + '-' + 
                    String(fromDateTime.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(fromDateTime.getDate()).padStart(2, '0');
    const toDateStr = toDateTime.getFullYear() + '-' + 
                  String(toDateTime.getMonth() + 1).padStart(2, '0') + '-' + 
                  String(toDateTime.getDate()).padStart(2, '0');
    
    console.log('Date formatting - fromDateStr:', fromDateStr, 'toDateStr:', toDateStr);
    
    fromDate.value = fromDateStr;
    toDate.value = toDateStr;
    
    fromTimeSlider.value = fromDateTime.getHours() * 60 + fromDateTime.getMinutes();
    toTimeSlider.value = toDateTime.getHours() * 60 + toDateTime.getMinutes();
    
    updateFromTimeDisplay();
    updateToTimeDisplay();
    updateTimeRangeSummary();
    
    // Mark preset as active
    document.querySelector(`[data-preset="${preset}"]`).classList.add('active');
    
    // Auto-apply the filter
    applyTimeFilterToMessages();
}

// Update time range summary
function updateTimeRangeSummary() {
    if (!timeRangeSummary || !summaryText || !summaryDetails) return;
    
    const fromDateValue = fromDate.value;
    const toDateValue = toDate.value;
    const fromTimeValue = parseInt(fromTimeSlider.value);
    const toTimeValue = parseInt(toTimeSlider.value);
    
    if (!fromDateValue || !toDateValue) {
        timeRangeSummary.style.display = 'none';
        return;
    }
    
    const fromDateTime = new Date(fromDateValue);
    fromDateTime.setHours(Math.floor(fromTimeValue / 60), fromTimeValue % 60, 0, 0);
    
    const toDateTime = new Date(toDateValue);
    toDateTime.setHours(Math.floor(toTimeValue / 60), toTimeValue % 60, 59, 999);
    
    const fromStr = fromDateTime.toLocaleString();
    const toStr = toDateTime.toLocaleString();
    
    // Calculate duration
    const duration = toDateTime - fromDateTime;
    const days = Math.floor(duration / (1000 * 60 * 60 * 24));
    const hours = Math.floor((duration % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    let durationText = '';
    if (days > 0) {
        durationText = `${days} day${days > 1 ? 's' : ''}`;
        if (hours > 0) {
            durationText += ` and ${hours} hour${hours > 1 ? 's' : ''}`;
        }
    } else if (hours > 0) {
        durationText = `${hours} hour${hours > 1 ? 's' : ''}`;
    } else {
        const minutes = Math.floor(duration / (1000 * 60));
        durationText = `${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
    
    summaryText.textContent = `From ${fromStr} to ${toStr}`;
    summaryDetails.textContent = `Duration: ${durationText}`;
    
    timeRangeSummary.style.display = 'block';
}

// Reset time filter to default
function resetTimeFilterToDefault() {
    // Clear any active preset
    presetButtons.forEach(btn => btn.classList.remove('active'));
    
    // Reset to default values
    initializeTimeFilter();
    
    // Clear the filter
    clearTimeFilterFromMessages();
    
    showNotification('Time filter reset to default', 'success');
}

// Enhanced time filter validation
function validateTimeRange() {
    const fromDateValue = fromDate.value;
    const toDateValue = toDate.value;
    const fromTimeValue = parseInt(fromTimeSlider.value);
    const toTimeValue = parseInt(toTimeSlider.value);
    
    if (!fromDateValue || !toDateValue) {
        showNotification('Please select both from and to dates', 'error');
        return false;
    }
    
    // Create date objects
    const fromDateTime = new Date(fromDateValue);
    fromDateTime.setHours(Math.floor(fromTimeValue / 60), fromTimeValue % 60, 0, 0);
    
    const toDateTime = new Date(toDateValue);
    toDateTime.setHours(Math.floor(toTimeValue / 60), toTimeValue % 60, 59, 999);
    
    if (fromDateTime >= toDateTime) {
        showNotification('From time must be before To time', 'error');
        return false;
    }
    
    // Check if range is too large (more than 1 year)
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    if (toDateTime - fromDateTime > oneYear) {
        showNotification('Time range cannot exceed 1 year', 'warning');
    }
    
    return true;
}

// Enhanced apply time filter
function applyTimeFilterToMessages() {
    if (!validateTimeRange()) {
        return;
    }
    
    const fromDateValue = fromDate.value;
    const toDateValue = toDate.value;
    const fromTimeValue = parseInt(fromTimeSlider.value);
    const toTimeValue = parseInt(toTimeSlider.value);
    
    // Create date objects
    const fromDateTime = new Date(fromDateValue);
    fromDateTime.setHours(Math.floor(fromTimeValue / 60), fromTimeValue % 60, 0, 0);
    
    const toDateTime = new Date(toDateValue);
    toDateTime.setHours(Math.floor(toTimeValue / 60), toTimeValue % 60, 59, 999);
    
    // Store filter settings
    timeFilter.enabled = true;
    timeFilter.fromDate = fromDateTime;
    timeFilter.toDate = toDateTime;
    
    // Update summary
    updateTimeRangeSummary();
    
    // Reload messages from server with the time filter applied
    if (currentPhoneNumbers.length > 0) {
        loadMergedMessages();
    } else if (currentPhoneNumber) {
        loadMessages(currentPhoneNumber);
    } else {
        // If no messages loaded, just filter existing ones
    filterMessagesByTime();
    }
    
    showNotification(`Filtering messages from ${fromDateTime.toLocaleString()} to ${toDateTime.toLocaleString()}`, 'success');
}

// Enhanced clear time filter
function clearTimeFilterFromMessages() {
    timeFilter.enabled = false;
    timeFilter.fromDate = null;
    timeFilter.toDate = null;
    
    // Clear active preset
    presetButtons.forEach(btn => btn.classList.remove('active'));
    
    // Hide summary
    if (timeRangeSummary) {
        timeRangeSummary.style.display = 'none';
    }
    
    // Reload messages without filter
    if (currentPhoneNumbers.length > 0) {
        loadMergedMessages();
    } else if (currentPhoneNumber) {
        loadMessages(currentPhoneNumber);
    }
    
    showNotification('Time filter cleared', 'success');
}

// Load more messages function
function loadMoreMessages() {
    if (!currentPhoneNumbers || currentPhoneNumbers.length === 0) {
        showError('No phone numbers set');
        return;
    }
    
    // Show loading state
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    }
    
    // Fetch messages with 30-day filter
    fetch('/messages-merged?days=30')
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            showError(`Error: ${data.error}`);
            return;
        }
        
        if (data.messages && data.messages.length > 0) {
            // Append new messages to existing ones
            data.messages.forEach(message => {
                if (!document.querySelector(`[data-message-id="${message.id}"]`)) {
                    addMessageToContainer(message);
                }
            });
            
            // Update message count
            const totalMessages = document.querySelectorAll('.message').length;
            if (messageCountInfo) {
                messageCountInfo.innerHTML = `Showing <span class="count">${totalMessages}</span> messages from last 30 days`;
            }
            
            showNotification(`Loaded ${data.messages.length} additional messages`, 'success');
        } else {
            showNotification('No additional messages found', 'info');
        }
    })
    .catch(error => {
        console.error('Error loading more messages:', error);
        showError('Failed to load more messages: ' + error.message);
    })
    .finally(() => {
        // Reset button state
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fas fa-plus"></i> Load More Messages (Last 30 Days)';
        }
    });
}

// Secret Code Search Functions
let secretCodeData = {
    code: '',
    group: '',
    customers: [],
    responses: new Map()
};


// Auto monitor function removed - using secret code search only

// Display secret code results
function displaySecretCodeResults(messagesData = null) {
    if (!secretCodeList) return;
    
    const total = secretCodeData.customers.length;
    const responded = secretCodeData.responses.size;
    const notResponded = total - responded;
    
    // Update stats
    if (totalCustomers) totalCustomers.textContent = total;
    if (respondedCount) respondedCount.textContent = responded;
    if (notRespondedCount) notRespondedCount.textContent = notResponded;
    
    // Display customer list
    displayCustomerList();
}

// Display customer list with view messages and mark received buttons
function displayCustomerList() {
    if (!secretCodeList) return;
    
    const html = secretCodeData.customers.map(customer => {
        const hasResponded = secretCodeData.responses.has(customer.phone);
        const hasLoadedMessages = secretCodeData.loadedMessages.has(customer.phone);
        
        return `
            <div class="customer-item" data-phone="${customer.phone}">
                <div class="customer-info">
                    <div class="customer-name">${customer.name}</div>
                    <div class="customer-group">${secretCodeData.group}</div>
                </div>
                <div class="customer-actions">
                            <button class="btn-view-messages" onclick="console.log('Button clicked for:', '${customer.phone}'); loadCustomerMessages('${customer.phone}')">
                                <i class="fas fa-comments"></i> View Messages
                            </button>
                    <button class="btn-mark-received" onclick="markCodeReceived('${customer.phone}')" ${hasResponded ? 'disabled' : ''}>
                        <i class="fas fa-check"></i> ${hasResponded ? 'Code Received' : 'Mark as Received'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    secretCodeList.innerHTML = html;
}

// Load messages for a specific customer
async function loadCustomerMessages(phoneNumber) {
    try {
        console.log('=== LOADING CUSTOMER MESSAGES ===');
        console.log('Phone:', phoneNumber);
        showNotification('Loading messages...', 'info');
        console.log('[SecretCode] loadCustomerMessages:start', {
            phoneNumber,
            timeRangeHours: secretCodeData.timeRangeHours,
            group: secretCodeData.group
        });
        
        // Get the time range in hours
        const timeRangeHours = secretCodeData.timeRangeHours;
        
        // Fetch messages for this specific customer
        const response = await fetch(`/messages/${phoneNumber}?days=${timeRangeHours / 24}`);
        console.log('[SecretCode] loadCustomerMessages:request', {
            url: `/messages/${phoneNumber}?days=${timeRangeHours / 24}`
        });
        
        if (!response.ok) {
            console.error('[SecretCode] loadCustomerMessages:http_error', response.status, response.statusText);
            throw new Error(`Failed to fetch messages: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const messages = data.messages || [];
        console.log('[SecretCode] loadCustomerMessages:response', {
            total: messages.length,
            sample: messages.slice(0, 3).map(m => ({ body: m.body, ts: m.timestamp }))
        });
        
        // Store loaded messages
        secretCodeData.loadedMessages.set(phoneNumber, messages);
        
        // Display messages for this customer
        displayCustomerMessages(phoneNumber, messages);
        
        console.log('[SecretCode] loadCustomerMessages:done', { phoneNumber, shown: messages.length });
        showNotification('Messages loaded successfully', 'success');
        
    } catch (error) {
        console.error('Error loading messages:', error);
        showNotification('Failed to load messages: ' + error.message, 'error');
    }
}

// Display messages for a specific customer
function displayCustomerMessages(phoneNumber, messages) {
    const customer = secretCodeData.customers.find(c => c.phone === phoneNumber);
    if (!customer) return;
    
    // Find the customer item in the DOM
    const customerItem = document.querySelector(`[data-phone="${phoneNumber}"]`);
    if (!customerItem) return;
    
    // Check if message viewer already exists
    let messageViewer = customerItem.querySelector('.message-viewer');
    
    if (!messageViewer) {
        // Create message viewer
        messageViewer = document.createElement('div');
        messageViewer.className = 'message-viewer';
        messageViewer.innerHTML = `
            <div class="message-viewer-header">
                <h4>Messages from ${customer.name}</h4>
                <button class="btn btn-sm btn-secondary" onclick="closeCustomerMessages('${phoneNumber}')">
                    <i class="fas fa-times"></i> Close
                </button>
            </div>
            <div class="message-list" id="messageList-${phoneNumber}">
                <!-- Messages will be loaded here -->
            </div>
            <div class="message-actions">
                <button class="btn btn-success" onclick="markCodeReceived('${phoneNumber}')">
                    <i class="fas fa-check"></i> Mark as Code Received
                </button>
            </div>
        `;
        
        // Insert after the customer item
        customerItem.parentNode.insertBefore(messageViewer, customerItem.nextSibling);
    }
    
    // Show the message viewer
    messageViewer.classList.add('active');
    
        // Display messages with highlighting
        const messageList = messageViewer.querySelector('.message-list');
        
        // Filter messages by time range
        const now = Date.now();
        const timeRangeMs = secretCodeData.timeRangeHours * 60 * 60 * 1000;
        const filteredMessages = messages.filter(msg => {
            const messageTime = msg.timestamp * 1000;
            return (now - messageTime) <= timeRangeMs;
        });
    console.log('[SecretCode] displayCustomerMessages', {
        phoneNumber,
        received: messages.length,
        withinRange: filteredMessages.length,
        timeRangeHours: secretCodeData.timeRangeHours
    });
        
        // Sort messages by timestamp (newest first)
        filteredMessages.sort((a, b) => b.timestamp - a.timestamp);
        
        const html = filteredMessages.map(msg => {
            const messageTime = new Date(msg.timestamp * 1000).toLocaleString();
            const isMatch = containsSecretCode(msg.body, secretCodeData.code, secretCodeData.includeThumbsUp);
            
            return `
                <div class="message-item ${isMatch ? 'highlighted' : ''}">
                    <div class="message-content">${highlightSecretCode(msg.body, secretCodeData.code, secretCodeData.includeThumbsUp)}</div>
                    <div class="message-meta">
                        ${messageTime} ${msg.isFromMe ? '(You)' : `(${msg.senderName})`}
                        ${isMatch ? '<span style="color: #28a745; font-weight: bold;"> ✓ MATCH</span>' : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        messageList.innerHTML = html;
}

// Close customer messages
function closeCustomerMessages(phoneNumber) {
    const customerItem = document.querySelector(`[data-phone="${phoneNumber}"]`);
    if (customerItem) {
        const messageViewer = customerItem.nextElementSibling;
        if (messageViewer && messageViewer.classList.contains('message-viewer')) {
            messageViewer.classList.remove('active');
        }
    }
}

// Mark code as received for a customer
async function markCodeReceived(phoneNumber) {
    try {
        const customer = secretCodeData.customers.find(c => c.phone === phoneNumber);
        if (!customer) {
            showNotification('Customer not found', 'error');
            return;
        }
        
        // Update local state
        secretCodeData.responses.set(phoneNumber, {
            timestamp: Date.now(),
            customer: customer
        });
        
        // Update Google Sheets
        const success = await updateAttendanceInGoogleSheets(phoneNumber, 'Y');
        
        if (success) {
            showNotification(`Code marked as received for ${customer.name}`, 'success');
            
            // Update the UI
            displayCustomerList();
            
            // Update stats
    const total = secretCodeData.customers.length;
    const responded = secretCodeData.responses.size;
    const notResponded = total - responded;
    
    if (totalCustomers) totalCustomers.textContent = total;
    if (respondedCount) respondedCount.textContent = responded;
    if (notRespondedCount) notRespondedCount.textContent = notResponded;
        } else {
            showNotification('Failed to update Google Sheets', 'error');
        }
        
    } catch (error) {
        console.error('Error marking code as received:', error);
        showNotification('Failed to mark code as received: ' + error.message, 'error');
    }
}

// Update attendance in Google Sheets
async function updateAttendanceInGoogleSheets(phoneNumber, status) {
    try {
        const response = await fetch('/api/update-attendance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phoneNumber: phoneNumber,
                status: status,
                groupName: secretCodeData.group
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to update attendance');
        }
        
        const result = await response.json();
        return result.success;
        
    } catch (error) {
        console.error('Error updating attendance:', error);
        return false;
    }
}

// Select all responded customers
function selectAllRespondedCustomers() {
    const checkboxes = secretCodeList.querySelectorAll('.secret-code-checkbox');
    checkboxes.forEach(checkbox => {
        const phone = checkbox.dataset.phone;
        const hasResponded = secretCodeData.responses.has(phone);
        checkbox.checked = hasResponded;
    });
}

// Select all not responded customers
function selectAllNotRespondedCustomers() {
    const checkboxes = secretCodeList.querySelectorAll('.secret-code-checkbox');
    checkboxes.forEach(checkbox => {
        const phone = checkbox.dataset.phone;
        const hasResponded = secretCodeData.responses.has(phone);
        checkbox.checked = !hasResponded;
    });
}

// Send reminder to selected customers
async function sendSecretCodeReminder() {
    const selectedCheckboxes = secretCodeList.querySelectorAll('.secret-code-checkbox:checked');
    
    if (selectedCheckboxes.length === 0) {
        showNotification('Please select customers to send reminder to', 'warning');
        return;
    }
    
    const selectedPhones = Array.from(selectedCheckboxes).map(cb => cb.dataset.phone);
    const selectedCustomers = secretCodeData.customers.filter(c => selectedPhones.includes(c.phone));
    
    // Create reminder message
    const thumbsUpHint = secretCodeData.includeThumbsUp ? ' (you can also use 👍 with the code)' : '';
    const reminderMessage = `🔔 Reminder: Please reply with the secret code "${secretCodeData.code}"${thumbsUpHint} to confirm your response.`;
    
    try {
        // Send reminder to each selected customer
        for (const customer of selectedCustomers) {
            await sendMessageToCustomer(customer.phone, reminderMessage);
        }
        
        showNotification(`Reminder sent to ${selectedCustomers.length} customers`, 'success');
        
    } catch (error) {
        console.error('Error sending reminders:', error);
        showNotification('Failed to send some reminders', 'error');
    }
}

// Send message to individual customer
async function sendMessageToCustomer(phoneNumber, message) {
    try {
        const response = await fetch('/send-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phoneNumber: phoneNumber,
                message: message
            })
        });
        
        const result = await response.json();
        return result;
    } catch (error) {
        console.error('Error sending message:', error);
        throw error;
    }
}

// Manual Secret Code Finder functionality
let secretCodeSearchData = {
    secretCode: '',
    groupName: '',
    timeRange: 24,
    customers: [],
    currentCustomer: null
};

// Initialize manual secret code finder
function initSecretCodeSearch() {
    console.log('🔍 Initializing Secret Code Search...');
    
    // Get DOM elements
    const secretCodeSection = document.getElementById('secretCodeSection');
    const backToSecretCodeBtn = document.getElementById('backToSecretCodeBtn');
    const startSecretCodeSearchBtn = document.getElementById('startSecretCodeSearch');
    const secretCodeInputPhase = document.getElementById('secretCodeInputPhase');
    const secretCodeCustomerPhase = document.getElementById('secretCodeCustomerPhase');
    const secretCodeMessagePhase = document.getElementById('secretCodeMessagePhase');
    const backToCustomerListBtn = document.getElementById('backToCustomerListBtn');
    const confirmSecretCodeBtn = document.getElementById('confirmSecretCodeBtn');
    const markNotReceivedBtn = document.getElementById('markNotReceivedBtn');
    
    // Event listeners
    backToSecretCodeBtn?.addEventListener('click', () => {
        showSection('secretCode');
    });
    
    // Secret code search button listener
    
    startSecretCodeSearchBtn?.addEventListener('click', startSecretCodeSearch);
    backToCustomerListBtn?.addEventListener('click', backToCustomerList);
    confirmSecretCodeBtn?.addEventListener('click', confirmSecretCode);
    markNotReceivedBtn?.addEventListener('click', markNotReceived);
    
    // Populate group dropdown
    populateSecretCodeGroupDropdown();
}

// Populate secret code group dropdown
async function populateSecretCodeGroupDropdown() {
    const secretCodeGroupSelect = document.getElementById('secretCodeGroupSelect');
    if (!secretCodeGroupSelect) return;
    
    try {
        let response = await fetch('/groups');
        let data = await response.json();
        
        // If no groups loaded yet, trigger server-side load and retry once
        if (!data.groups || data.groups.length === 0) {
            try {
                await fetch('/groups/load');
                response = await fetch('/groups');
                data = await response.json();
            } catch (e) {
                console.error('Failed to auto-load groups:', e);
            }
        }
        
        secretCodeGroupSelect.innerHTML = '<option value="">Select a group...</option>';
        
        if (data.groups && data.groups.length > 0) {
            data.groups.forEach(group => {
                const option = document.createElement('option');
                option.value = group.name; // Use group name as value since that's what the server expects
                option.textContent = group.name;
                secretCodeGroupSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading groups for secret code search:', error);
    }
}

// Start secret code search
async function startSecretCodeSearch() {
    const secretCodeInput = document.getElementById('secretCodeInput');
    const groupSelect = document.getElementById('secretCodeGroupSelect');
    const timeRangeSelect = document.getElementById('secretCodeTimeRange');
    
    const secretCode = secretCodeInput.value.trim();
    const groupName = groupSelect.value;
    const timeRange = parseInt(timeRangeSelect.value);
    
    if (!secretCode) {
        alert('Please enter a secret code to search for.');
        return;
    }
    
    if (!groupName) {
        alert('Please select a group.');
        return;
    }
    
    console.log('🔍 Starting Secret Code Search:', {
        secretCode,
        groupName,
        timeRange
    });
    
    secretCodeSearchData.secretCode = secretCode;
    secretCodeSearchData.groupName = groupName;
    secretCodeSearchData.timeRange = timeRange;
    
    try {
        // Show loading
        const startBtn = document.getElementById('startSecretCodeSearch');
        const originalText = startBtn.innerHTML;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading Customers...';
        startBtn.disabled = true;
        
        // Get customers from the selected group (NO MESSAGE LOADING YET)
        const group = currentGroups[groupName];
        if (!group || !group.customers) {
            alert('Group not found or has no customers.');
            return;
        }
        
        console.log('📋 Loading customers from group:', groupName, 'Count:', group.customers.length);
        
        // Just show the customer list without loading messages
        secretCodeSearchData.customers = group.customers.map(customer => ({
            phoneNumber: customer.phone,
            name: customer.name,
            messages: [], // Empty initially - will be loaded on demand
            hasSecretCode: false // Will be determined when messages are loaded
        }));
        
        console.log('✅ Customer list loaded:', secretCodeSearchData.customers.length, 'customers');
            
            // Show customer list
            showCustomerList();
        
    } catch (error) {
        console.error('❌ Error loading customers:', error);
        alert('Error loading customers: ' + error.message);
    } finally {
        // Reset button
        const startBtn = document.getElementById('startSecretCodeSearch');
        startBtn.innerHTML = '<i class="fas fa-search"></i> Search Messages';
        startBtn.disabled = false;
    }
}

// Process customers from messages
function processCustomersFromMessages(messages, secretCode) {
    const customerMap = new Map();
    
    // Build lookup from current group to resolve names by phone
    const group = currentGroups[secretCodeSearchData.groupName];
    const phoneToName = new Map();
    if (group && Array.isArray(group.customers)) {
        group.customers.forEach(c => {
            const clean = (c.phone || '').toString().replace(/\D/g, '');
            if (clean) phoneToName.set(clean, c.name || '');
        });
    }
    
    messages.forEach(message => {
        const keyPhone = (message.sourcePhone || '').toString().replace(/\D/g,'');
        const rawFrom = message.from || '';
        const cleanPhone = keyPhone || rawFrom.replace(/@.*/, '').replace(/\D/g, '');
        const displayPhone = `${cleanPhone}@c.us`;
        const resolvedName = phoneToName.get(cleanPhone) || message.customerName || message.senderName || 'Unknown';
        
        if (!customerMap.has(displayPhone)) {
            customerMap.set(displayPhone, {
                phoneNumber: displayPhone,
                name: resolvedName,
                messages: [],
                hasSecretCode: false
            });
        }
        
        const customer = customerMap.get(displayPhone);
        customer.messages.push(message);
        
        if (message.body && secretCode && message.body.toLowerCase().includes(secretCode.toLowerCase())) {
            customer.hasSecretCode = true;
        }
    });
    
    return Array.from(customerMap.values());
}

// Show customer list
function showCustomerList() {
    const secretCodeInputPhase = document.getElementById('secretCodeInputPhase');
    const secretCodeCustomerPhase = document.getElementById('secretCodeCustomerPhase');
    const searchInfoText = document.getElementById('searchInfoText');
    const customerList = document.getElementById('secretCodeCustomerList');
    
    // Update search info
    searchInfoText.textContent = `Searching for "${secretCodeSearchData.secretCode}" in last ${secretCodeSearchData.timeRange} hours - Found ${secretCodeSearchData.customers.length} customers`;
    
    console.log('📋 Displaying customer list:', secretCodeSearchData.customers.length, 'customers');
    
    // Populate customer list
    customerList.innerHTML = '';
    
    secretCodeSearchData.customers.forEach((customer, index) => {
        // Safely get phoneNumber - use customer.phone if phoneNumber is missing
        const phoneNumber = customer.phoneNumber || customer.phone || 'unknown';
        
        const customerItem = document.createElement('div');
        customerItem.className = 'customer-item';
        customerItem.setAttribute('data-phone', phoneNumber);
        
        // Check if customer is already confirmed (we'll update this after checking Google Sheets)
        const isConfirmed = customer.isConfirmed || false;
        const statusText = customer.hasSecretCode ? 
            (isConfirmed ? '✓ Confirmed' : '✓ Potential Match') : 
            'No Code Yet';
        const statusClass = customer.hasSecretCode ? 
            (isConfirmed ? 'confirmed' : 'has-code') : 
            'no-code';
        
        customerItem.innerHTML = `
            <div class="customer-info">
                <div class="customer-name">${customer.name}</div>
                <div class="customer-phone">${phoneNumber}</div>
                <div class="customer-status">
                    <span class="status-indicator ${statusClass}">
                        ${statusText}
                    </span>
                </div>
            </div>
            <div class="customer-actions">
                <button class="btn-view-messages" onclick="loadCustomerMessages('${phoneNumber}')">
                    <i class="fas fa-comments"></i> View Messages
                </button>
            </div>
        `;
        customerList.appendChild(customerItem);
    });
    
    // Show customer phase
    secretCodeInputPhase.style.display = 'none';
    secretCodeCustomerPhase.style.display = 'block';
}

// Load customer messages on demand
async function loadCustomerMessages(phoneNumber) {
    console.log('📱 Loading messages for customer:', phoneNumber);
    
    try {
        // Find the customer
        const customer = secretCodeSearchData.customers.find(c => c.phoneNumber === phoneNumber);
        if (!customer) {
            console.error('❌ Customer not found:', phoneNumber);
            return;
        }
        
        console.log('🔍 Fetching messages for:', customer.name, phoneNumber);
        
        // Show loading state
        const customerItem = document.querySelector(`[data-phone="${phoneNumber}"]`);
        const viewBtn = customerItem.querySelector('.btn-view-messages');
        const originalText = viewBtn.innerHTML;
        viewBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        viewBtn.disabled = true;
        
        // Fetch messages for this specific customer
        const response = await fetch(`/messages/${phoneNumber}?days=${secretCodeSearchData.timeRange / 24}`);
        console.log('📡 API Response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch messages: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const messages = data.messages || [];
        console.log('📨 Messages received:', messages.length, 'messages');
        
        // Process messages and check for secret code
        customer.messages = messages;
        
        // Check each message for secret code with detailed logging
        const secretCode = secretCodeSearchData.secretCode.toLowerCase();
        console.log('🔍 Checking messages for secret code:', secretCode);
        
        let foundMatches = [];
        customer.hasSecretCode = messages.some((msg, index) => {
            let containsCode = false;
            if (msg.body) {
                const messageBody = msg.body.toLowerCase();
                containsCode = messageBody.includes(secretCode);
                if (containsCode) {
                    foundMatches.push({
                        index: index,
                        body: msg.body,
                        timestamp: msg.timestamp
                    });
                }
                console.log(`📝 Message ${index}:`, {
                    body: msg.body,
                    containsCode: containsCode,
                    searchTerm: secretCode
                });
            }
            return containsCode;
        });
        
        console.log('✅ Messages processed:', {
            totalMessages: messages.length,
            hasSecretCode: customer.hasSecretCode,
            secretCode: secretCodeSearchData.secretCode,
            foundMatches: foundMatches.length,
            matchDetails: foundMatches
        });
        
        // Update the customer item in the UI
        updateCustomerItem(customer);
        
        // Show messages
        showCustomerMessages(customer);
        
    } catch (error) {
        console.error('❌ Error loading messages:', error);
        alert('Failed to load messages: ' + error.message);
    } finally {
        // Reset button
        const customerItem = document.querySelector(`[data-phone="${phoneNumber}"]`);
        if (customerItem) {
            const viewBtn = customerItem.querySelector('.btn-view-messages');
            viewBtn.innerHTML = '<i class="fas fa-comments"></i> View Messages';
            viewBtn.disabled = false;
        }
    }
}

// Update customer item in the UI
function updateCustomerItem(customer) {
    const customerItem = document.querySelector(`[data-phone="${customer.phoneNumber}"]`);
    if (!customerItem) return;
    
    // Update status indicator
    const statusIndicator = customerItem.querySelector('.status-indicator');
    if (statusIndicator) {
        const isConfirmed = customer.isConfirmed || false;
        const statusText = customer.hasSecretCode ? 
            (isConfirmed ? '✓ Confirmed' : '✓ Potential Match') : 
            'No Code Yet';
        const statusClass = customer.hasSecretCode ? 
            (isConfirmed ? 'confirmed' : 'has-code') : 
            'no-code';
        
        statusIndicator.className = `status-indicator ${statusClass}`;
        statusIndicator.textContent = statusText;
        
        console.log('🔍 Updated customer status:', {
            phoneNumber: customer.phoneNumber,
            hasSecretCode: customer.hasSecretCode,
            isConfirmed: isConfirmed,
            statusText: statusText,
            statusClass: statusClass
        });
    }
}

// Show customer messages
function showCustomerMessages(customer) {
    console.log('👁️ Showing messages for:', customer.name);
    
    const secretCodeCustomerPhase = document.getElementById('secretCodeCustomerPhase');
    const secretCodeMessagePhase = document.getElementById('secretCodeMessagePhase');
    const selectedCustomerInfo = document.getElementById('selectedCustomerInfo');
    const messageList = document.getElementById('secretCodeMessageList');
    
    // Update customer info
    selectedCustomerInfo.textContent = `${customer.name} (${customer.phoneNumber})`;
    
    // Populate messages
    messageList.innerHTML = '';
    
    if (customer.messages.length === 0) {
        messageList.innerHTML = '<div class="no-messages">No messages found for this customer.</div>';
    } else {
        customer.messages.forEach((message, messageIndex) => {
        const messageItem = document.createElement('div');
        messageItem.className = 'message-item';
            
            // Check if message contains secret code (case insensitive)
            const hasSecretCode = message.body && message.body.toLowerCase().includes(secretCodeSearchData.secretCode.toLowerCase());
            if (hasSecretCode) {
                messageItem.classList.add('has-secret-code');
            }
        
        // Highlight secret code matches
        let messageContent = message.body || '';
            if (messageContent && secretCodeSearchData.secretCode) {
                const regex = new RegExp(`(${secretCodeSearchData.secretCode})`, 'gi');
            messageContent = messageContent.replace(regex, '<span class="secret-code-match">$1</span>');
        }
        
        messageItem.innerHTML = `
            <div class="message-content">${messageContent}</div>
            <div class="message-time">${new Date(message.timestamp * 1000).toLocaleString()}</div>
                        <div class="secret-code-indicator">
                            <span class="code-status ${hasSecretCode ? 'potential' : 'regular'}">${hasSecretCode ? '✓ Potential Match' : 'Regular Message'}</span>
                            <button class="btn-confirm-code" onclick="confirmSecretCodeMatch('${customer.phoneNumber}', ${messageIndex}, this)">
                                <i class="fas fa-check"></i> Confirm
                            </button>
                        </div>
        `;
        messageList.appendChild(messageItem);
    });
    }
    
    // Show message phase
    secretCodeCustomerPhase.style.display = 'none';
    secretCodeMessagePhase.style.display = 'block';
}

// Confirm secret code match and update Google Sheets
async function confirmSecretCodeMatch(phoneNumber, messageIndex, element) {
    try {
        console.log('🎯 Confirming secret code match for:', phoneNumber, 'message index:', messageIndex);
        
        // Update Google Sheets
        const result = await updateCustomerAttendance(phoneNumber, 'Y');
        console.log('✅ Attendance updated successfully:', result);
        
        // Update the customer's confirmed status in the data
        const customer = secretCodeSearchData.customers.find(c => c.phoneNumber === phoneNumber);
        if (customer) {
            customer.isConfirmed = true;
        }
        
        // Update the UI to show it's confirmed
        const confirmBtn = element || document.querySelector(`[onclick*="confirmSecretCodeMatch('${phoneNumber}', ${messageIndex})"]`);
        if (confirmBtn) {
            confirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmed';
            confirmBtn.disabled = true;
            confirmBtn.style.backgroundColor = '#28a745';
        }
        
        // Update the status indicator
        const codeStatus = confirmBtn.parentElement.querySelector('.code-status');
        if (codeStatus) {
            codeStatus.textContent = '✓ Confirmed';
            codeStatus.style.color = '#28a745';
            codeStatus.style.fontWeight = 'bold';
        }
        
        // Refresh the customer list to show updated status
        showCustomerList();
        
        // Show success notification
        showNotification(`Secret code confirmed for customer!`, 'success');
        
        // Auto-return to customer list after 2 seconds
        setTimeout(() => {
            backToCustomerList();
        }, 2000);
        
    } catch (error) {
        console.error('❌ Error confirming secret code match:', error);
        showNotification('Failed to confirm secret code: ' + error.message, 'error');
    }
}

// Mark customer as received
async function markCustomerReceived(customerIndex) {
    console.log('🎯 markCustomerReceived called with index:', customerIndex);
    console.log('🎯 secretCodeSearchData.customers:', secretCodeSearchData.customers);
    
    try {
        const customer = secretCodeSearchData.customers[customerIndex];
        console.log('🎯 Marking customer as received:', customer.name, customer.phoneNumber);
        
        // Update Google Sheets
        const result = await updateCustomerAttendance(customer.phoneNumber, 'Y');
        console.log('✅ Attendance updated successfully:', result);
        
        // Update the customer's confirmed status in the data
        customer.isConfirmed = true;
        
        // Refresh the customer list to show updated status
        showCustomerList();
        
        // Show success notification
        showNotification(`Customer ${customer.name} marked as received!`, 'success');
        
    } catch (error) {
        console.error('❌ Error marking customer as received:', error);
        showNotification('Failed to mark customer as received: ' + error.message, 'error');
    }
}

// Back to customer list
function backToCustomerList() {
    const secretCodeCustomerPhase = document.getElementById('secretCodeCustomerPhase');
    const secretCodeMessagePhase = document.getElementById('secretCodeMessagePhase');
    
    secretCodeMessagePhase.style.display = 'none';
    secretCodeCustomerPhase.style.display = 'block';
}

// Confirm secret code
async function confirmSecretCode() {
    if (!secretCodeSearchData.currentCustomer) return;
    
    try {
        await updateCustomerAttendance(secretCodeSearchData.currentCustomer.phoneNumber, 'Y');
        alert('Customer marked as received in Google Sheets!');
        
        // Go back to customer list
        backToCustomerList();
        
        // Update the customer in the list
        const customerIndex = secretCodeSearchData.customers.findIndex(c => c.phoneNumber === secretCodeSearchData.currentCustomer.phoneNumber);
        if (customerIndex !== -1) {
            markCustomerReceived(customerIndex);
        }
        
    } catch (error) {
        console.error('Error updating attendance:', error);
        alert('Error updating attendance: ' + error.message);
    }
}

// Mark as not received
async function markNotReceived() {
    if (!secretCodeSearchData.currentCustomer) return;
    
    try {
        await updateCustomerAttendance(secretCodeSearchData.currentCustomer.phoneNumber, 'N');
        alert('Customer marked as not received in Google Sheets!');
        
        // Go back to customer list
        backToCustomerList();
        
    } catch (error) {
        console.error('Error updating attendance:', error);
        alert('Error updating attendance: ' + error.message);
    }
}

// Update customer attendance in Google Sheets
async function updateCustomerAttendance(phoneNumber, status) {
    try {
        console.log('📊 Updating attendance for:', phoneNumber, 'to:', status, 'with secret code:', secretCodeSearchData.secretCode);
        
        const response = await fetch('/api/update-attendance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                phoneNumber: phoneNumber,
                status: status,
                groupName: secretCodeSearchData.groupName,
                secretCode: secretCodeSearchData.secretCode
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to update attendance');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error updating attendance:', error);
        throw error;
    }
}

// Initialize manual secret code finder when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initSecretCodeSearch();
});

