# Railway Volumes Setup for WhatsApp Session Persistence

## Problem
On Railway's free tier, your WhatsApp session is lost every time the container restarts. You need to scan the QR code again after each refresh or deployment.

## Solution: Use Railway Volumes

Railway Volumes provide persistent storage that survives container restarts.

## Step-by-Step Setup

### 1. Upgrade to Pro Plan
- Go to [Railway Dashboard](https://railway.app/dashboard)
- Click on your billing settings
- Upgrade to **Pro plan** ($5/month minimum)
- This gives you access to Volumes feature

### 2. Create a Volume

1. **Navigate to Your Service**
   - Open your project in Railway dashboard
   - Click on your WhatsApp app service

2. **Go to Volumes Tab**
   - Click the **"Volumes"** tab at the top
   - You'll see an empty volumes list (if no volumes exist)

3. **Create New Volume**
   - Click **"+ New Volume"** button
   - **Name**: `whatsapp-session`
   - **Mount Path**: `/app/.wwebjs_auth`
   - Click **"Add"**

### 3. Redeploy

After adding the volume:

1. Go to **"Deployments"** tab
2. Click **"Redeploy"** on the latest deployment
3. Wait for deployment to complete

### 4. Scan QR Code Once

1. Open your Railway app URL
2. Scan the QR code with WhatsApp
3. Wait for "WhatsApp Connected" status

### 5. Test Persistence

1. **Refresh the page** → Should stay connected ✅
2. **Redeploy the app** → Should stay connected ✅
3. **Wait for auto-restart** → Should stay connected ✅

## What Gets Stored

The volume stores:
- `session.data.json` - Your WhatsApp authentication data
- `LegacyAuth/` - Legacy session files
- All files in `.wwebjs_auth/` directory

**Note**: These files are encrypted and secure. No one else can use them.

## Cost

- **Pro Plan**: $5/month (includes 5GB storage)
- **Additional Storage**: $0.25 per GB/month

## Alternative: Free Tier Workaround

If you can't upgrade to Pro plan:

### Option 1: Keep Browser Tab Open
- Don't close the browser tab
- Use browser "pin tab" feature
- Session stays active while tab is open

### Option 2: Use Localhost Testing
- Test locally on your computer
- Use Railway only for production
- Sessions persist locally

### Option 3: Auto-Scan Script
- Create a script to auto-scan QR codes
- May violate WhatsApp ToS
- Not recommended

## Verification

After setup, check Railway logs:

```
✅ WhatsApp client authenticated
✅ WhatsApp client is ready!
```

These should appear **without** needing to scan after restart.

## Troubleshooting

### Volume Not Working

1. **Check mount path**: Must be exactly `/app/.wwebjs_auth`
2. **Check volume name**: Must be unique within service
3. **Redeploy**: After changes, always redeploy

### Still Asking to Scan

1. **Wait longer**: First scan after volume setup takes extra time
2. **Clear browser cache**: Old session data might interfere
3. **Check logs**: Look for authentication errors

### Volume Full

1. Go to **Volumes** tab
2. See storage usage
3. Upgrade plan if needed
4. Or clear old session files (requires rescan)

## Need Help?

- Railway Docs: https://docs.railway.app/develop/volumes
- Railway Support: support@railway.app
- GitHub Issues: Create an issue in your repo

