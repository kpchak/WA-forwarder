# WhatsApp Message Viewer

A web application that connects to WhatsApp via QR code scanning and displays messages for any given phone number.

## Features

- 🔗 Connect to WhatsApp using QR code scanning
- 📱 View messages for any phone number
- 🔄 Real-time message updates
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
2. **Message Retrieval**: Once authenticated, you can enter any phone number to view their messages
3. **Real-time Updates**: New messages are displayed in real-time using Socket.IO
4. **Local Storage**: Authentication data is stored locally for future sessions

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

## License

MIT License - feel free to use and modify as needed.

## Disclaimer

This application is for educational purposes. Please respect privacy and use responsibly. Only view messages you have legitimate access to.
