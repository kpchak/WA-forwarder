# ✨ Auto-Detect Group IDs Feature

## What's New?

You can now add **WhatsApp group IDs** to Google Sheets in **3 easy formats**! No need to remember the full `@g.us` suffix.

## Supported Formats

### 1. Full Format (Recommended)
```
120363419990566229@g.us
```
- Works exactly as before
- No changes needed if you already have this

### 2. Numeric Only ✨ NEW
```
120363419990566229
```
- Just the numbers!
- Automatically detects as group ID
- Adds `@g.us` automatically

### 3. With Spaces (Cleaned)
```
120 363 419990566229@g.us
```
- Spaces are automatically removed
- Works the same as full format

## How It Works

The app uses smart detection:

1. **Checks if it has `@g.us` or `@c.us`** → Use as-is
2. **Checks if it's 15-20 digits starting with `120`** → Auto-add `@g.us`
3. **Otherwise** → Treat as regular contact number

## Examples

### Example 1: Just Numbers
```csv
Name,Phone Number
Admin Group,120363419990566229
```

**Result:**
- ✅ Loaded as: `120363419990566229@g.us`
- ✅ Sends to the group correctly!

### Example 2: Full Format
```csv
Name,Phone Number
Admin Group,120363419990566229@g.us
```

**Result:**
- ✅ Loaded as: `120363419990566229@g.us`
- ✅ Sends to the group correctly!

### Example 3: Mixed Sheet
```csv
Name,Phone Number
John Doe,9876543210
Admin Group,120363419990566229
Jane Smith,919876543211
```

**Result:**
- ✅ John Doe: Regular contact
- ✅ Admin Group: Auto-detected as group
- ✅ Jane Smith: Regular contact

## Why This Helps

### Before
❌ Had to remember: `120363419990566229@g.us`  
❌ Easy to make mistakes  
❌ Harder to type in Google Sheets

### Now
✅ Just type: `120363419990566229`  
✅ App figures it out automatically  
✅ Less prone to errors

## Detection Logic

The app determines if a number is a group ID based on:

```javascript
// Numbers 15-20 digits long starting with "120"
if (digitsOnly.length >= 15 && 
    digitsOnly.length <= 20 && 
    digitsOnly.startsWith('120')) {
  // It's a group ID!
  return `${digitsOnly}@g.us`;
}
```

**Why 120?** WhatsApp group IDs always start with `120`.

**Why 15-20 digits?** That's the typical range for WhatsApp group IDs.

## Real-World Example

Your group ID: `120363419990566229@g.us`

**Google Sheet:**
```
| Name                    | Phone Number          |
|-------------------------|-----------------------|
| Admin Group             | 120363419990566229    |  ← Just numbers!
```

**After loading:**
```
| Admin Group             | 120363419990566229@g.us |  ← Auto-added!
```

## Testing

To test the feature:

1. Add a group ID in your Google Sheet using just numbers
2. Click "Load from Google Sheets" in the app
3. Look at the console logs - you'll see:
   ```
   Auto-detected group ID: 120363419990566229
   ```
4. Send a test message to the group
5. It should work! ✅

## Troubleshooting

### Not Auto-Detecting?

**Check the format:**
- ✅ Must be **15-20 digits long**
- ✅ Must **start with `120`**
- ✅ No letters or special characters (except `@g.us`)

**Examples:**
- ✅ `120363419990566229` (works - 18 digits, starts with 120)
- ❌ `919876543210` (doesn't work - regular phone number)
- ❌ `363419990566229` (doesn't work - doesn't start with 120)
- ❌ `1203634199` (doesn't work - too short)

### Still Having Issues?

Use the full format as a fallback:
```csv
Name,Phone Number
Admin Group,120363419990566229@g.us
```

This always works!

## Backward Compatibility

✅ **Existing sheets work as before**  
✅ **No changes needed**  
✅ **Both old and new formats supported**

## Summary

🎉 **Now you can add group IDs to Google Sheets easily!**

**Just type the numbers:** `120363419990566229`  
**The app handles the rest!** ✨


