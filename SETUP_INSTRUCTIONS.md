# WhatsApp Forwarder - Setup Instructions

## 🚀 Quick Start

### 1. Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- WhatsApp account

### 2. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd "WA forwarder"

# Install dependencies
npm install

# Create environment file
copy .env.example .env
```

### 3. Configuration

#### Environment Variables
Create a `.env` file with the following:

```env
# Port (default: 3000)
PORT=3000

# Google Sheets Integration (Optional)
GOOGLE_CLIENT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour key\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id
```

#### Google Sheets Setup (Optional)
1. Follow instructions in `GOOGLE_SHEETS_SETUP.md`
2. Place your credentials file in `Gsheet/` directory
3. Share your Google Sheet with the service account email

### 4. Run the Application

```bash
# Development mode (auto-restart)
npm run dev

# Production mode
npm start
```

### 5. Access the Application
Open your browser and navigate to: `http://localhost:3000`

## 📋 Features

### Core Features
- ✅ WhatsApp QR Code Authentication
- ✅ Message Viewing & Filtering
- ✅ Customer Group Management
- ✅ Bulk Message Forwarding
- ✅ Attendance Tracking
- ✅ Date & Time Filter
- ✅ Media Support

### Advanced Features
- ✅ Secret Code Monitoring
- ✅ Google Sheets Integration
- ✅ Real-time Updates via WebSocket
- ✅ Message Copy to Clipboard
- ✅ Multiple Customer Groups

## 🔧 Configuration

### Customer Groups
The application can load customer groups from Google Sheets:
- Each sheet = One customer group
- Phone numbers in international format
- Automatic phone number formatting

### Message Filtering
- Filter by date range
- Filter by time (with slider)
- Filter by days/hours
- View only incoming messages

## 📁 Project Structure

```
WA forwarder/
├── public/              # Frontend files
│   ├── index.html      # Main HTML
│   ├── script.js       # Client-side JavaScript
│   └── style.css       # Styling
├── Gsheet/             # Google credentials (not in git)
├── server.js           # Express server
├── .env                # Environment variables
├── .gitignore          # Git ignore rules
├── package.json        # Dependencies
└── README.md           # Project documentation
```

## 🔒 Security Notes

### Important Security Considerations
1. **Never commit credentials** - `.env` and `Gsheet/*.json` are excluded
2. **Keep credentials private** - Don't share API keys or tokens
3. **Use HTTPS in production** - WebSocket connections need secure connections
4. **Regular backups** - Backup your authentication data

### Files NOT in Repository
- `.env` - Environment variables
- `node_modules/` - Dependencies
- `Gsheet/*.json` - Google credentials
- `.wwebjs_cache/` - WhatsApp session cache

## 🌐 Deployment

### Local Development
Perfect for testing and development on your local machine.

### Server Deployment
For production deployment:
1. Set up environment variables on server
2. Use PM2 or similar for process management
3. Configure reverse proxy (nginx)
4. Enable HTTPS with SSL certificates
5. Set up firewall rules

### Docker (Coming Soon)
Docker support for easy deployment across platforms.

## 🐛 Troubleshooting

### Common Issues

#### QR Code Not Appearing
- Check internet connection
- Verify port 3000 is not in use
- Restart the server

#### WhatsApp Authentication Fails
- Clear browser cache
- Delete `.wwebjs_cache/` directory
- Restart application

#### Messages Not Loading
- Verify phone number format (+countrycode+number)
- Check WhatsApp is connected
- Verify client ready status

#### Google Sheets Not Working
- Check service account permissions
- Verify credentials file exists
- Check spreadsheet ID is correct

### Getting Help
- Check the README.md for detailed documentation
- Review GOOGLE_SHEETS_SETUP.md for Google Sheets setup
- Check server logs for error messages

## 📝 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `GOOGLE_CLIENT_EMAIL` | Yes* | - | Google Service Account email |
| `GOOGLE_PRIVATE_KEY` | Yes* | - | Google Service Account private key |
| `GOOGLE_SPREADSHEET_ID` | Yes* | - | Google Spreadsheet ID |

*Required only if using Google Sheets integration

## 🔄 Updating the Application

```bash
# Pull latest changes
git pull origin main

# Update dependencies
npm install

# Restart server
npm start
```

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📧 Support

For issues and questions:
- Create an issue on GitHub
- Check existing documentation
- Review troubleshooting section

---

**Note**: This application is for educational and legitimate business purposes only. Use responsibly and respect privacy.

