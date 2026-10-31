# Greenery Therapy Nook website (Dr. Minerva Molon)

Static site plus one Vercel serverless function (`api/book.js`).

## Clinic details
Edit the `CONFIG` block near the bottom of `index.html`: phone, email, address, hours, weekly schedule, bank details and consultation fees.

## Booking emails with payment receipts
When a patient submits the form, `api/book.js` emails the booking straight away (with their mobile number, so the clinic can follow up on payment). The patient then sees the Landbank details, pays, and uploads the receipt, which arrives as a second email with the receipt attached.

Set these in Vercel → Project → Settings → Environment Variables, then redeploy:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | API key from https://resend.com (free plan) |
| `CLINIC_EMAIL` | Address that receives bookings (comma-separate several) |
| `FROM_EMAIL` | Optional. Sender on a domain verified in Resend, e.g. `Dr. Minerva Molon <bookings@yourdomain.com>` |

Without `FROM_EMAIL`, Resend's test sender is used, which only delivers to the email you signed up to Resend with.
Until the variables are set, patients see their booking summary and are asked to send it with the receipt to the clinic manually.

## GoHighLevel (automation)
| Variable | Value |
|---|---|
| `GHL_WEBHOOK_URL` | Inbound Webhook URL from the "Website bookings" workflow |
| `GHL_API_KEY` | Sub-account Private Integration token with the `medias.write` scope. Receipts are uploaded to the sub-account's Media Storage and the workflow receives `receipt_url`, `receipt_file_id`, `receipt_file_name`. |
| `GHL_RECEIPTS_FOLDER_ID` | Optional: id of a Media Storage folder for receipts |
