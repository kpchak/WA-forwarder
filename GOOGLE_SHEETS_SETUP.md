# Google Sheets Integration Setup

## Overview
This application can load customer groups from Google Sheets and send messages to them. Each sheet in your Google Spreadsheet represents a different customer group.

## Setup Instructions

### 1. Create a Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Sheets API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Sheets API"
   - Click on it and press "Enable"

### 2. Create a Service Account
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "Service Account"
3. Fill in the service account details:
   - Name: `whatsapp-bot-service`
   - Description: `Service account for WhatsApp bot`
4. Click "Create and Continue"
5. Skip the optional steps and click "Done"

### 3. Generate Service Account Key
1. In the Credentials page, find your service account
2. Click on the service account email
3. Go to the "Keys" tab
4. Click "Add Key" > "Create new key"
5. Choose "JSON" format
6. Download the JSON file

### 4. Share Your Google Sheet
1. Open your Google Sheet
2. Click "Share" button
3. Add the service account email (from step 2) with "Editor" permissions
4. Copy the Spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   ```

### 5. Configure Environment Variables
Create a `.env` file in your project root with:

```env
GOOGLE_CLIENT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id-here
```

### 6. Google Sheet Format
Your Google Sheet should have:
- **One sheet per customer group**
- **Column headers** in the first row
- **Phone number column** with names like "phone", "number", "whatsapp"
- **Name column** with names like "name", "customer"

Example sheet structure:
```
| Name        | Phone Number | Email           |
|-------------|--------------|-----------------|
| John Doe    | 9876543210   | john@email.com |
| Jane Smith  | 9876543211   | jane@email.com |
```

## Features

### Customer Groups
- Load customer groups from Google Sheets
- Each sheet = one customer group
- Automatic phone number formatting
- Customer name and phone number extraction

### Message Sending
- Send text messages to entire groups
- Send media messages (images, videos, documents)
- Real-time delivery status tracking
- Detailed results for each customer

### Attendance Tracking
- Mark customers as present/absent
- Track attendance per group
- View attendance history

## Usage

1. **Load Groups**: Click "Load from Google Sheets" to import your customer groups
2. **View Groups**: See all your customer groups with member counts
3. **Send Messages**: Click "Send Message" on any group to compose and send messages
4. **Track Attendance**: View group details and mark attendance for each customer

## Troubleshooting

### Common Issues
1. **"Google Sheets not configured"**: Check your environment variables
2. **"Failed to load groups"**: Verify the service account has access to the sheet
3. **"No groups found"**: Check your sheet format and column names

### Required Permissions
- The service account needs "Editor" access to your Google Sheet
- The Google Sheets API must be enabled in your Google Cloud project

### Sheet Requirements
- First row must contain headers
- Must have a phone number column
- Phone numbers should be in format: 9876543210 or +919876543210
- Each sheet represents one customer group

