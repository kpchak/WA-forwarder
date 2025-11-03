# Exclude Master Sheet Feature

## Summary
Added functionality to exclude the "Master" sheet when loading customer groups from Google Sheets to prevent accidental mass messaging.

## Changes Made
- Modified `loadCustomerGroups()` function in `server.js` (lines 1668-1676)
- Added `excludedSheets` array containing `['Master']`
- Added logic to skip excluded sheets during loading
- Console log message when a sheet is skipped

## How It Works
```javascript
// Exclude "Master" sheet to prevent accidental mass messaging
const excludedSheets = ['Master'];

for (const sheetName of sheetNames) {
  // Skip excluded sheets
  if (excludedSheets.includes(sheetName)) {
    console.log(`Skipping excluded sheet: ${sheetName}`);
    continue;
  }
  // ... rest of loading logic
}
```

## Testing Instructions

### Local Testing:
1. Open http://localhost:3000 in your browser
2. Click "Load from Google Sheets" or refresh the page
3. Verify that "Master" group does NOT appear in the customer groups list
4. Check browser console for "Skipping excluded sheet: Master" message (if connected to server logs)

### Railway Deployment:
1. Push changes to GitHub
2. Railway will auto-deploy
3. Visit your Railway URL
4. Click "Load from Google Sheets"
5. Verify that "Master" group does NOT appear

## Adding More Excluded Sheets
To exclude additional sheets, simply add them to the `excludedSheets` array:

```javascript
const excludedSheets = ['Master', 'Archive', 'Old Contacts'];
```

## Safety Benefits
- Prevents accidental bulk messaging to all contacts
- Adds a layer of protection against mistakes
- Easy to configure which sheets to exclude
- Maintains all other sheets functionality

## Notes
- The exclusion only affects the group loading process
- Groups are loaded fresh on every "Load from Google Sheets" click
- No caching - each load fetches current data from Google Sheets
- Server logs will show which sheets are being skipped

## Server Logs
When loading groups, you should see:
```
Available sheets: ['Admin', 'Master', 'Potential', 'Yes', 'HM', 'MMS25', '3B3P']
Skipping excluded sheet: Master
Loaded 3 customers from sheet: Admin
Loaded 1 customers from sheet: Potential
...
```

## Related Files
- `server.js` - Main backend file with exclusion logic
- `public/script.js` - Frontend JavaScript for loading groups
- `public/index.html` - UI for customer groups display

