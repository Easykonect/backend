/**
 * Email Queue Worker
 * 
 * Processes email sending jobs from the queue
 */

import { Job } from 'bullmq';
import { queueManager, QUEUE_NAMES, EmailJobData } from './index';
import { sendEmail } from '@/lib/email';

// ===========================================
// Email Templates
// ===========================================
const EMAIL_TEMPLATES: Record<string, (data: Record<string, unknown>) => { subject: string; html: string }> = {
  // Welcome email
  welcome: (data) => ({
    subject: `Welcome to EasyKonnect, ${data.name}!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Welcome to EasyKonnect! 🎉</h1>
        <p>Hi ${data.name},</p>
        <p>Thank you for joining EasyKonnect. We're excited to have you on board!</p>
        <p>You can now:</p>
        <ul>
          <li>Browse and book services from verified providers</li>
          <li>Chat directly with service providers</li>
          <li>Track your bookings in real-time</li>
          <li>Leave reviews and ratings</li>
        </ul>
        <p>If you have any questions, our support team is here to help.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // OTP verification
  otp: (data) => ({
    subject: `Your EasyKonnect Verification Code: ${data.otp}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Verification Code</h1>
        <p>Hi,</p>
        <p>Your verification code is:</p>
        <div style="background: #F3F4F6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #4F46E5;">${data.otp}</span>
        </div>
        <p>This code will expire in ${data.expiresIn || '10 minutes'}.</p>
        <p>If you didn't request this code, please ignore this email.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Password reset
  passwordReset: (data) => ({
    subject: 'Reset Your EasyKonnect Password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Password Reset Request</h1>
        <p>Hi ${data.name || 'there'},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${data.resetUrl}" style="background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">Reset Password</a>
        </div>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Booking confirmation
  bookingConfirmed: (data) => ({
    subject: `Booking Confirmed - ${data.serviceName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">Booking Confirmed! ✅</h1>
        <p>Hi ${data.customerName},</p>
        <p>Great news! Your booking has been confirmed.</p>
        <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Booking Details</h3>
          <p><strong>Service:</strong> ${data.serviceName}</p>
          <p><strong>Provider:</strong> ${data.providerName}</p>
          <p><strong>Date:</strong> ${data.bookingDate}</p>
          <p><strong>Time:</strong> ${data.bookingTime}</p>
          <p><strong>Amount:</strong> ${data.amount}</p>
        </div>
        <p>You can track your booking status in the EasyKonnect app.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Booking cancelled
  bookingCancelled: (data) => ({
    subject: `Booking Cancelled - ${data.serviceName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #EF4444;">Booking Cancelled</h1>
        <p>Hi ${data.name},</p>
        <p>Your booking for <strong>${data.serviceName}</strong> has been cancelled.</p>
        ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
        ${data.refundInfo ? `<p><strong>Refund:</strong> ${data.refundInfo}</p>` : ''}
        <p>If you have any questions, please contact our support team.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // New message notification
  newMessage: (data) => ({
    subject: `New message from ${data.senderName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">New Message 💬</h1>
        <p>Hi ${data.recipientName},</p>
        <p>You have a new message from <strong>${data.senderName}</strong>:</p>
        <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4F46E5;">
          <p style="margin: 0;">"${data.messagePreview}"</p>
        </div>
        <p>Log in to EasyKonnect to reply.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Provider verification approved
  verificationApproved: (data) => ({
    subject: 'Your EasyKonnect Provider Account is Verified! 🎉',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #10B981;">Verification Approved! ✅</h1>
        <p>Hi ${data.name},</p>
        <p>Congratulations! Your provider account has been verified.</p>
        <p>You can now:</p>
        <ul>
          <li>List your services on the platform</li>
          <li>Receive bookings from customers</li>
          <li>Accept payments directly</li>
          <li>Build your reputation with reviews</li>
        </ul>
        <p>Start adding your services today!</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Provider verification rejected
  verificationRejected: (data) => ({
    subject: 'Action Required: Provider Verification',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #EF4444;">Verification Update</h1>
        <p>Hi ${data.name},</p>
        <p>We've reviewed your provider application, and we need additional information.</p>
        ${data.reason ? `<p><strong>Details:</strong> ${data.reason}</p>` : ''}
        <p>Please update your application with the required information.</p>
        <p>If you have questions, our support team is here to help.</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),

  // Review received
  reviewReceived: (data) => ({
    subject: `New ${data.rating}-Star Review Received`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4F46E5;">New Review! ⭐</h1>
        <p>Hi ${data.providerName},</p>
        <p>You received a new ${data.rating}-star review from <strong>${data.customerName}</strong>:</p>
        <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;">${'⭐'.repeat(Number(data.rating))}</p>
          <p style="margin: 0; font-style: italic;">"${data.reviewText}"</p>
        </div>
        <p>Thank them by responding to their review!</p>
        <p>Best regards,<br>The EasyKonnect Team</p>
      </div>
    `,
  }),
};

// ===========================================
// Email Processor
// ===========================================
async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { to, subject, html, text, template, templateData } = job.data;

  console.log(`📧 Processing email job ${job.id} to ${to}`);

  let emailSubject = subject;
  let emailHtml = html;

  // Use template if specified
  if (template && EMAIL_TEMPLATES[template] && templateData) {
    const templateContent = EMAIL_TEMPLATES[template](templateData);
    emailSubject = emailSubject || templateContent.subject;
    emailHtml = emailHtml || templateContent.html;
  }

  // Send the email
  const result = await sendEmail({
    to,
    subject: emailSubject,
    html: emailHtml,
    text: text || emailHtml.replace(/<[^>]+>/g, ''), // Strip HTML for plain text
  });

  if (!result) {
    throw new Error('Failed to send email');
  }

  console.log(`✅ Email sent successfully to ${to}`);
}

// ===========================================
// Initialize Email Worker
// ===========================================
export function initializeEmailWorker(): void {
  queueManager.registerWorker<EmailJobData>(
    QUEUE_NAMES.EMAIL,
    processEmailJob,
    3 // Process 3 emails concurrently
  );

  console.log('✅ Email worker initialized');
}

export default initializeEmailWorker;
