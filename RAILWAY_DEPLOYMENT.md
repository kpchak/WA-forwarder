# Railway Deployment Guide

This guide will help you deploy the WhatsApp Forwarder app to Railway.

## Prerequisites

1. GitHub account with your code pushed to a repository
2. Railway account (sign up at https://railway.app)
3. Google Sheets credentials (if using Google Sheets features)

## Step 1: Connect GitHub to Railway

1. Go to https://railway.app and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Select your repository
5. Railway will automatically detect it's a Node.js project

## Step 2: Configure Environment Variables

In your Railway project dashboard, go to **Variables** tab and add:

### Required for Google Sheets (if using):
```
GOOGLE_CLIENT_EMAIL=your-service-account-email@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour\nMulti\nLine\nPrivate\nKey\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id
```

**Important Notes:**
- For `GOOGLE_PRIVATE_KEY`, you need to include the actual newlines (`\n`) in the value
- Railway will automatically provide `PORT` - no need to set it manually
- Make sure the private key includes the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

## Step 3: Configure Build Settings

### Option A: Using Dockerfile (Recommended)
If you have a `Dockerfile` in your repo (which we've created), Railway will automatically:
- Build using Docker
- Install Chrome/Chromium dependencies
- Set up the environment properly

**No additional configuration needed** - Railway detects and uses the Dockerfile automatically.

### Option B: Without Dockerfile
Railway should automatically detect:
- **Build Command**: `npm install` (automatic)
- **Start Command**: `npm start` (from package.json)

If not, you can manually set:
- Build Command: Leave empty (Railway auto-detects)
- Start Command: `npm start`

## Step 4: Important Considerations

### WhatsApp Session Persistence
⚠️ **Important**: Railway instances are **ephemeral** - they restart and data is lost. This means:

1. **WhatsApp session will be lost on restart** - You'll need to scan QR code again after each deploy/restart
2. **Session files are in `.wwebjs_auth/`** - These are gitignored and won't persist

### Solutions:
1. Use Railway Volumes (Paid): Create a volume for `.wwebjs_auth/` directory to persist sessions
2. Use WhatsApp Web.js remote auth: Implement a remote auth strategy to save session outside Railway
3. Accept re-scanning: Scan QR code each time after deployment

### Puppeteer/Chrome Requirements
WhatsApp Web.js uses Puppeteer which requires Chrome. Railway's Node.js buildpack includes it, but if you encounter issues:

1. Ensure Puppeteer args are set in `server.js` (already configured):
   ```javascript
   args: ['--no-sandbox', '--disable-setuid-sandbox']
   ```

2. If Chrome errors occur, you may need to add:
   ```javascript
   executablePath: process.env.CHROMIUM_PATH || undefined,
   ```

## Step 5: Deploy

1. Railway will automatically deploy when you push to your GitHub repo
2. Or manually click "Deploy" in Railway dashboard
3. Wait for build to complete
4. Click on your service to get the public URL

## Step 6: Access Your App

1. Railway will provide a public URL (e.g., `https://your-app-name.up.railway.app`)
2. Open this URL in your browser
3. Scan the QR code with WhatsApp to connect
4. Note: You'll need to re-scan after each restart

## Step 7: Monitor Logs

- Click on your service in Railway dashboard
- Go to "Logs" tab to see real-time logs
- Check for any errors or warnings

## Troubleshooting

### Issue: Build fails
- Check that `package.json` is correct
- Ensure all dependencies are listed
- Check Railway logs for specific errors

### Issue: App starts but can't connect
- Verify environment variables are set correctly
- Check that `PORT` is not manually set (Railway provides it)
- Review logs for WhatsApp connection errors

### Issue: WhatsApp session lost
- This is expected behavior - Railway instances are stateless
- Consider using Railway Volumes (requires paid plan) or implement remote auth

### Issue: Chrome/Puppeteer errors
- Ensure `--no-sandbox` and `--disable-setuid-sandbox` are in puppeteer args
- Check Railway logs for Chrome-related errors

## Environment Variables Summary

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | ✅ Auto-set | Railway automatically sets this |
| `GOOGLE_CLIENT_EMAIL` | ⚠️ Optional | Service account email for Google Sheets |
| `GOOGLE_PRIVATE_KEY` | ⚠️ Optional | Service account private key (with \n) |
| `GOOGLE_SPREADSHEET_ID` | ⚠️ Optional | Google Spreadsheet ID |

## Additional Resources

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway

## Notes

- **Free Tier**: Limited resources, may have cold starts
- **Custom Domain**: Can be configured in Railway dashboard
- **HTTPS**: Automatically enabled by Railway
- **Auto-Deploy**: Enable in settings to deploy on every push

