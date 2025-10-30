# WhatsApp Forwarder

A comprehensive WhatsApp web application for managing customer groups, forwarding messages, and tracking attendance. Built with Node.js, Express, and whatsapp-web.js.

## Features

- 🔗 Connect to WhatsApp using QR code scanning
- 📱 View and filter messages with date/time controls
- 🔄 Real-time message updates via WebSocket
- 📋 Customer Group Management via Google Sheets
- 📤 Bulk message forwarding to groups
- ✅ Attendance tracking and marking
- 🔍 Secret code monitoring
- 📋 Copy messages to clipboard for analysis
- 📱 Responsive web interface
- 🔒 Secure local authentication

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- A smartphone with WhatsApp installed

## Installation

1. Clone or download this project
2. Navigate to the project directory
3. Install dependencies:

```bash
npm install
```

4. Configure environment variables (optional for Google Sheets):

```bash
# Create .env file from example
copy .env.example .env
# Edit .env with your Google Sheets credentials
```

## Usage

1. Start the server:

```bash
npm start
```

2. Open your browser and go to `http://localhost:3000`

3. Scan the QR code with your WhatsApp:
   - Open WhatsApp on your phone
   - Go to Settings > Linked Devices
   - Tap "Link a Device"
   - Scan the QR code displayed on the web page

4. Once connected, enter a phone number in international format (e.g., +1234567890)

5. View messages for that phone number in real-time

## Development

For development with auto-restart:

```bash
npm run dev
```

## How it Works

1. **QR Code Authentication**: The app generates a QR code that you scan with your WhatsApp mobile app to authenticate
2. **Message Retrieval**: Once authenticated, you can add phone numbers or load customer groups from Google Sheets
3. **Message Filtering**: Filter messages by date range, time, or number of days
4. **Group Management**: Load customer groups from Google Sheets, send bulk messages, and track attendance
5. **Real-time Updates**: New messages are displayed in real-time using Socket.IO
6. **Attendance Tracking**: Mark customer attendance directly in Google Sheets

## Advanced Features

### Customer Groups
- Load customer groups from Google Sheets
- Each sheet represents a customer group
- Automatic phone number formatting
- Send messages to selected customers

### Message Filtering
- Filter by date range with time slider
- Filter by number of days
- Filter by hours
- View only incoming messages

### Attendance System
- Mark customer attendance
- Track attendance in Google Sheets
- Generate absentee lists
- Send follow-up messages to absentees

## Security Notes

- Authentication data is stored locally on your machine
- The app only displays messages that are already accessible through your WhatsApp account
- No data is sent to external servers

## Troubleshooting

### Common Issues

1. **QR Code not appearing**: Make sure you have a stable internet connection
2. **Authentication fails**: Try refreshing the page and scanning the QR code again
3. **Messages not loading**: Ensure the phone number is in international format (+countrycode+number)

### Browser Compatibility

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Documentation

For detailed setup and configuration:
- [Setup Instructions](SETUP_INSTRUCTIONS.md) - Complete setup guide
- [Google Sheets Setup](GOOGLE_SHEETS_SETUP.md) - Google Sheets integration
- [Optimization Notes](OPTIMIZATION_NOTES.md) - Performance and deployment tips

## License

MIT License - feel free to use and modify as needed.

## Disclaimer

This application is for educational and legitimate business purposes only. Please respect privacy and use responsibly. Only view messages you have legitimate access to.
