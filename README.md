# Dr. Minerva Molon website

Static site plus one Vercel serverless function (`api/book.js`).

## Clinic details
Edit the `CONFIG` block near the bottom of `index.html`: phone, email, address, hours, weekly schedule, bank details and consultation fees.

## Booking emails with payment receipts
Patients deposit the fee to the Landbank account, upload the receipt, and `api/book.js` emails the booking with the receipt attached.

Set these in Vercel → Project → Settings → Environment Variables, then redeploy:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | API key from https://resend.com (free plan) |
| `CLINIC_EMAIL` | Address that receives bookings (comma-separate several) |
| `FROM_EMAIL` | Optional. Sender on a domain verified in Resend, e.g. `Dr. Minerva Molon <bookings@yourdomain.com>` |

Without `FROM_EMAIL`, Resend's test sender is used, which only delivers to the email you signed up to Resend with.
Until the variables are set, patients see their booking summary and are asked to send it with the receipt to the clinic manually.
