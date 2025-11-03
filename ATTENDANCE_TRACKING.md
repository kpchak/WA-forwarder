# Attendance Tracking Feature

## Overview
The attendance tracking system now writes all attendance records to a dedicated "Attendance" sheet in Google Sheets, making it easy to create pivot tables and custom reports.

## Sheet Structure

The "Attendance" sheet has the following columns:

| Column | Description | Format |
|--------|-------------|--------|
| **Date** | Date of attendance | YYYY-MM-DD (e.g., 2025-11-03) |
| **Time** | Time of attendance mark | HH:MM:SS (e.g., 14:30:45) |
| **Group** | Group/Sheet name | Text (e.g., "Admin", "3B3P") |
| **Member** | Member name or phone | Text |
| **Message** | Optional message/note | Text (e.g., "Secret Code: CODE") |

## How It Works

### Automatic Sheet Creation
- The "Attendance" sheet is **automatically created** when the first attendance record is written
- Headers are automatically added: `Date`, `Time`, `Group`, `Member`, `Message`

### When Attendance is Recorded

1. **Manual Attendance Marking**
   - When you mark attendance for a customer through the UI
   - Writes a row with: Date, Time, Group, Member Name, and optional Message

2. **Secret Code Tracking**
   - When a customer responds with a secret code
   - Writes a row with: Date, Time, Group, Member Name, Message (e.g., "Secret Code: CODE")

3. **Check Absentees Feature**
   - Attendance records are written when absentees are marked as present

## Data Format Examples

### Example Row 1 (Manual Attendance):
```
Date: 2025-11-03
Time: 14:30:45
Group: Admin
Member: John Doe
Message: (empty)
```

### Example Row 2 (Secret Code Response):
```
Date: 2025-11-03
Time: 15:22:10
Group: 3B3P
Member: Jane Smith
Message: Secret Code: GIFT
```

## Benefits

### 1. Pivot Table Ready
- Each attendance mark is a separate row
- Perfect for creating pivot tables in Google Sheets
- Filter, group, and analyze by Date, Group, Member, etc.

### 2. Customizable Reports
- Create attendance summaries by group
- Track attendance trends over time
- Identify most/least active members
- Filter by date ranges easily

### 3. Historical Tracking
- All attendance records are preserved
- See when each member was marked present
- Track message context (secret codes, notes)

## Creating Pivot Tables

### Example 1: Daily Attendance Count by Group
1. Select all data in the Attendance sheet
2. Insert > Pivot Table
3. Rows: Date
4. Columns: Group
5. Values: Count of Member

### Example 2: Member Attendance Summary
1. Insert > Pivot Table
2. Rows: Member
3. Values: Count of Date
4. Filter by Group (optional)

### Example 3: Monthly Attendance Trend
1. Insert > Pivot Table
2. Rows: Month (extracted from Date)
3. Values: Count of Date
4. Group by: Group (optional)

## API Endpoints

### POST `/groups/:groupName/attendance`
Mark attendance for a customer

**Request Body:**
```json
{
  "customerPhone": "919840407490",
  "status": "present",
  "month": "2025-11",
  "message": "Optional message here"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Attendance updated for customer 919840407490",
  "attendance": { ... }
}
```

### POST `/api/update-attendance`
Update attendance via secret code

**Request Body:**
```json
{
  "phoneNumber": "919840407490",
  "status": "present",
  "groupName": "Admin",
  "secretCode": "CODE"
}
```

## Technical Details

### File Location
- Function: `writeAttendanceToSheet()` in `server.js` (line ~1640)
- Called from: `updateAttendance()` and `updateCustomerAttendance()`

### Error Handling
- If Google Sheets API fails, the attendance marking still succeeds
- Attendance sheet write failures are logged but don't block the main flow
- Old attendance tracking (marking "P" in group sheets) still works

### Performance
- Each attendance mark appends one row
- Minimal performance impact
- Uses Google Sheets batch API for efficiency

## Notes

1. **Duplicate Prevention**: Each attendance mark is written only once per day per member
2. **Time Zone**: Times are recorded in server time zone
3. **Message Field**: Optional - can be used for notes, secret codes, or any context
4. **Backward Compatible**: Old attendance tracking still works alongside new system

## Troubleshooting

### Sheet Not Created?
- Check Google Sheets API permissions
- Verify `GOOGLE_SPREADSHEET_ID` is set correctly
- Check server logs for errors

### Missing Records?
- Check if attendance was actually marked (not duplicate)
- Verify Google Sheets API credentials
- Check server logs for write errors

### Incorrect Dates/Times?
- Server uses system time zone
- Dates are in YYYY-MM-DD format (ISO 8601)
- Times are in HH:MM:SS format (24-hour)

## Future Enhancements

Potential improvements:
- Support for custom date ranges in reports
- Export to CSV functionality
- Real-time attendance dashboard
- Attendance statistics API endpoints
- Bulk attendance marking

