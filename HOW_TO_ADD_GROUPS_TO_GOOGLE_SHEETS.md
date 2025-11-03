# How to Add WhatsApp Groups to Google Sheets

## Overview
You can add WhatsApp **groups** to your Google Sheets just like individual contacts. The app supports both individual contacts and WhatsApp groups. Groups can now receive messages just like individual contacts! ✨

## What You Need
1. **WhatsApp Group ID** - A unique identifier like `120363123456789012@g.us`
2. **Group Name** - The display name of the group (e.g., "Admin Group - Karthikeyan")
3. **Access to your Google Sheet**

## Step 1: Get Your WhatsApp Group ID

### Method 1: From the App (Easiest)

1. **Open your app** (connected to WhatsApp)
2. Go to **"Messages"** section
3. Click **"Show All Chats"** button
4. Look for your group in the list
5. You'll see something like:
   ```
   👥 Admin Group - Karthikeyan
   📝 GROUP
   ID: 120363123456789012@g.us
   ```
6. **Copy the ID** (everything after "ID: ")

### Method 2: From Railway Logs

1. **Open Railway dashboard**
2. Go to your service → **"Logs"** tab
3. Look for lines like:
   ```
   Processing contact/group 1/5: 120363123456789012@g.us
   Chat found: Admin Group - Karthikeyan
   ```
4. **Copy the group ID** from the processing line

### Method 3: From Your Console Logs

If you already have the group working in merged messages:

1. **Open browser console** (F12)
2. Look for logs like:
   ```
   Fetching merged messages for selected phone numbers: ['919865064475@c.us', '120363341879375384@g.us', ...]
   ```
3. **Copy the group ID** (the one with `@g.us`)

## Step 2: Add to Google Sheets

### 🆕 Auto-Detection Feature!

**Great news!** You can now add group IDs in **3 different formats**:

1. ✅ **Full format**: `120363341879375384@g.us` (recommended)
2. ✅ **Numeric only**: `120363341879375384` (auto-adds `@g.us`)
3. ✅ **With spaces**: `120 363 341879375384@g.us` (auto-cleans)

The app will automatically detect and add the `@g.us` suffix if needed!

### Option A: Add as a New Sheet

If you want the group to appear as a separate **group in the Customer Groups section**:

1. **Open your Google Sheet**
2. Click **"+"** at the bottom to add a new sheet
3. **Name it** with your group's display name (e.g., "Admin Group")
4. Add headers in **Row 1**:
   ```
   | Name            | Phone Number       |
   |-----------------|--------------------|
   ```
5. Add your group in **Row 2** (all these formats work!):
   ```
   | Admin Group     | 120363341879375384@g.us |  ← Recommended
   | Admin Group     | 120363341879375384      |  ← Auto-detects!
   | Admin Group     | 120363341879375384      |  ← Works too!
   ```
6. **Save** the sheet

### Option B: Add to an Existing Sheet

If you want to add groups to an **existing customer group**:

1. **Open your Google Sheet**
2. Go to the sheet you want (e.g., "Master", "Admin")
3. In the **Phone Number** column, you can add:
   - Individual contacts: `9876543210`
   - WhatsApp groups: `120363341879375384@g.us` OR `120363341879375384`
4. In the **Name** column, add the display name
5. **Save** the sheet

### Example Sheet Structure

**Sheet: "Admin Groups"**
```
| Name                        | Phone Number           |
|-----------------------------|------------------------|
| Admin Group - Karthikeyan   | 120363341879375384@g.us|
| MM Family - Chakravarthi    | 120363419990566229@g.us|
| Pugal Niftchennai          | 919840407490@c.us      |
```

**Sheet: "Customer List"**
```
| Name           | Phone Number           |
|----------------|------------------------|
| John Doe       | 9876543210             |
| Admin Group    | 120363341879375384@g.us|
| Jane Smith     | 9876543211             |
```

## Step 3: Reload in the App

1. **Go to your app**
2. Click **"Customer Groups"** tab
3. Click **"Load from Google Sheets"** button
4. Your groups should now appear in the list!

## How It Works

### Individual Contacts
- Phone number: `9876543210` or `919876543210`
- Automatically converts to: `919876543210@c.us`
- Name shows as: "John Doe" (from name column)

### WhatsApp Groups
**3 formats supported:**

1. **Full format**: `120363341879375384@g.us` → Used as-is
2. **Numeric only**: `120363341879375384` → Auto-adds `@g.us` ✨
3. **With spaces**: `120 363 341879375384@g.us` → Auto-cleans to full format

**Detection logic:** Numbers 15-20 digits long starting with `120` are automatically detected as group IDs!

- Name shows as: "Admin Group - Karthikeyan"

### In Merged Messages
When you select multiple items from your Google Sheets:
- Groups show as: "👥 Admin Group - Karthikeyan"
- Contacts show as: "👤 Pugal Niftchennai"

Both work exactly the same way!

## Tips

### Tip 1: Create a Separate Sheet for Groups
If you have many groups, create a dedicated sheet:
- Sheet name: "Groups"
- Contains only WhatsApp groups
- Makes it easy to manage

### Tip 2: Use Descriptive Names
- ✅ Good: "Admin Group - Karthikeyan"
- ✅ Good: "MM Family - Chakravarthi"
- ❌ Bad: "Group1"
- ❌ Bad: "Ag"

### Tip 3: Test First
1. Add **one group** to your sheet
2. Reload in the app
3. Verify it appears correctly
4. Then add more

### Tip 4: Keep IDs Safe
WhatsApp group IDs are **unique and permanent**:
- Once you have it, you can reuse it
- Copy it to multiple sheets if needed
- Keep a backup of your group IDs

## Troubleshooting

### Problem: "Group not found"
**Solution:**
- Verify the group ID is correct
- Make sure it has `@g.us` at the end
- Check that the format is exactly like: `120363123456789012@g.us` (no spaces)

### Problem: "Group not loading"
**Solution:**
- Click "Load from Google Sheets" again
- Check Railway logs for errors
- Verify the sheet name matches exactly

### Problem: "Can't find the ID"
**Solution:**
- Use Method 1 (Show All Chats) - it's the easiest
- Make sure you're connected to WhatsApp
- Check that the group exists in your WhatsApp

### Problem: "ID looks wrong"
**Solution:**
- Group IDs are long numbers + `@g.us`
- Contact IDs are: `919876543210@c.us`
- Make sure you copied the entire ID

## Need Help?

If you're still having issues:
1. Check Railway logs for detailed error messages
2. Verify your Google Sheet format matches the examples
3. Test with one group first before adding many

## Quick Reference

**Contact Format:**
```
Phone Number: 9876543210
Result: 919876543210@c.us
```

**Group Format:**
```
Phone Number: 120363341879375384@g.us
Result: 120363341879375384@g.us (no change)
```

Both work in the same sheet! 🎉

