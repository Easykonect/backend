/**
 * Email Service
 * Uses Resend HTTP API — avoids SMTP port blocking on shared hosting.
 */

import { Resend } from 'resend';
import { config } from '@/config';

const resend = new Resend(process.env.RESEND_API_KEY);

// ==========================================
// Shared Email Layout Helpers
// ==========================================

const BRAND_COLOR = '#003C3A';
const LOGO_URL = 'https://api.easykonnet.com/logo.png';

const emailHeader = () => `
  <div style="background: ${BRAND_COLOR}; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <img src="${LOGO_URL}" alt="Easykonnet" width="60" height="60" style="display: block; margin: 0 auto 12px auto;">
    <h1 style="color: #ffffff; margin: 0; font-size: 22px; letter-spacing: 1px;">Easykonnet</h1>
  </div>
`;

const emailFooter = (extra = '') => `
  <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
  <p style="color: #999; font-size: 12px; text-align: center;">
    © ${new Date().getFullYear()} Easykonnet. All rights reserved.<br>
    ${extra}This is an automated message, please do not reply.
  </p>
`;

const emailWrapper = (content: string) => `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9;">
      ${emailHeader()}
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
        ${content}
      </div>
    </body>
  </html>
`;

/**
 * Email templates
 */
const emailTemplates = {
  /**
   * Email verification OTP template
   */
  verificationOtp: (otp: string, firstName: string): { subject: string; html: string; text: string } => ({
    subject: 'Verify Your Easykonnet Account',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>Welcome to Easykonnet! To complete your registration, please verify your email address using the code below:</p>
      <div style="background: #f0f7f7; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px dashed ${BRAND_COLOR};">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: ${BRAND_COLOR};">${otp}</span>
      </div>
      <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
      <p style="color: #666; font-size: 14px;">If you didn't create an account with Easykonnet, please ignore this email.</p>
      ${emailFooter()}
    `),
    text: `
Hello ${firstName},

Welcome to Easykonnet! To complete your registration, please verify your email address using the code below:

Your verification code: ${otp}

This code will expire in 10 minutes.

If you didn't create an account with Easykonnet, please ignore this email.

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),

  /**
   * Password reset OTP template
   */
  passwordResetOtp: (otp: string, firstName: string): { subject: string; html: string; text: string } => ({
    subject: 'Reset Your Easykonnet Password',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>We received a request to reset your password. Use the code below to proceed:</p>
      <div style="background: #f0f7f7; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px dashed ${BRAND_COLOR};">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: ${BRAND_COLOR};">${otp}</span>
      </div>
      <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
      <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Security Notice:</strong> If you didn't request a password reset, please secure your account immediately.</p>
      ${emailFooter()}
    `),
    text: `
Hello ${firstName},

We received a request to reset your password. Use the code below to proceed:

Your reset code: ${otp}

This code will expire in 10 minutes.

⚠️ Security Notice: If you didn't request a password reset, please secure your account immediately.

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),

  /**
   * Login alert template
   */
  loginAlert: (firstName: string, ip: string, time: string): { subject: string; html: string; text: string } => ({
    subject: 'New Login to Your Easykonnet Account',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>We detected a new login to your Easykonnet account:</p>
      <div style="background: #f0f7f7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND_COLOR};">
        <p style="margin: 5px 0;"><strong>Time:</strong> ${time}</p>
        <p style="margin: 5px 0;"><strong>IP Address:</strong> ${ip}</p>
      </div>
      <p style="color: #666; font-size: 14px;">If this was you, no action is needed.</p>
      <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Please change your password immediately and contact our support team.</p>
      ${emailFooter()}
    `),
    text: `
Hello ${firstName},

We detected a new login to your Easykonnet account:

Time: ${time}
IP Address: ${ip}

If this was you, no action is needed.

⚠️ Not you? Please change your password immediately and contact our support team.

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),

  /**
   * Provider Approved template
   */
  providerApproved: (firstName: string, businessName: string): { subject: string; html: string; text: string } => ({
    subject: 'Your Provider Account Has Been Approved!',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>Great news! Your provider account <strong>"${businessName}"</strong> has been verified and approved.</p>
      <div style="background: #e6f4f1; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND_COLOR};">
        <h3 style="margin: 0 0 10px 0; color: ${BRAND_COLOR};">✅ You're Now Verified!</h3>
        <p style="margin: 0; color: #004d40;">You can now:</p>
        <ul style="margin: 10px 0 0 0; color: #004d40;">
          <li>Create and publish services</li>
          <li>Receive booking requests from customers</li>
          <li>Start earning on Easykonnet</li>
        </ul>
      </div>
      <p>Log in to your dashboard to start creating services and growing your business!</p>
      <div style="text-align: center; margin: 25px 0;">
        <a href="${config.platform.frontendUrl}/provider/dashboard" style="background: ${BRAND_COLOR}; color: white; padding: 14px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 15px;">Go to Dashboard</a>
      </div>
      ${emailFooter(`Welcome to the Easykonnet provider community!<br>`)}
    `),
    text: `
Hello ${firstName},

Great news! Your provider account "${businessName}" has been verified and approved.

✅ You're Now Verified!

You can now:
- Create and publish services
- Receive booking requests from customers
- Start earning on Easykonnet

Dashboard: ${config.platform.frontendUrl}/provider/dashboard

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),

  /**
   * Provider Rejected template
   */
  providerRejected: (firstName: string, businessName: string, reason: string): { subject: string; html: string; text: string } => ({
    subject: 'Update on Your Provider Application',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>We've reviewed your provider application for <strong>"${businessName}"</strong>, and unfortunately, we're unable to approve it at this time.</p>
      <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
        <h3 style="margin: 0 0 10px 0; color: #856404;">Reason for Rejection:</h3>
        <p style="margin: 0; color: #856404;">${reason}</p>
      </div>
      <h3 style="color: #333;">What You Can Do:</h3>
      <ol style="color: #666;">
        <li>Review the feedback above</li>
        <li>Update your provider profile with the required information</li>
        <li>Re-submit your application for verification</li>
      </ol>
      <p>If you have questions, please contact our support team.</p>
      <div style="text-align: center; margin: 25px 0;">
        <a href="${config.platform.frontendUrl}/provider/profile" style="background: ${BRAND_COLOR}; color: white; padding: 14px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 15px;">Update Profile</a>
      </div>
      ${emailFooter(`Need help? Contact ${config.platform.supportEmail}<br>`)}
    `),
    text: `
Hello ${firstName},

We've reviewed your provider application for "${businessName}", and unfortunately, we're unable to approve it at this time.

Reason for Rejection:
${reason}

What You Can Do:
1. Review the feedback above
2. Update your provider profile with the required information
3. Re-submit your application for verification

Update Profile: ${config.platform.frontendUrl}/provider/profile

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
Need help? Contact ${config.platform.supportEmail}
    `,
  }),

  /**
   * Provider Submission Received template
   */
  providerSubmissionReceived: (firstName: string, businessName: string): { subject: string; html: string; text: string } => ({
    subject: 'We Received Your Provider Application!',
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>Thank you for submitting your provider application for <strong>"${businessName}"</strong>!</p>
      <div style="background: #f0f7f7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND_COLOR};">
        <h3 style="margin: 0 0 10px 0; color: ${BRAND_COLOR};">📋 Application Status: Under Review</h3>
        <p style="margin: 0; color: #004d40;">Our team is reviewing your application. This typically takes 1-2 business days.</p>
      </div>
      <h3 style="color: #333;">What Happens Next?</h3>
      <ol style="color: #666;">
        <li>Our team will verify the information you provided</li>
        <li>We may contact you if we need additional information</li>
        <li>You'll receive an email once a decision has been made</li>
      </ol>
      <p>In the meantime, you can prepare your services so you're ready to publish as soon as you're approved!</p>
      ${emailFooter(`Questions? Contact ${config.platform.supportEmail}<br>`)}
    `),
    text: `
Hello ${firstName},

Thank you for submitting your provider application for "${businessName}"!

📋 Application Status: Under Review

Our team is reviewing your application. This typically takes 1-2 business days.

What Happens Next?
1. Our team will verify the information you provided
2. We may contact you if we need additional information
3. You'll receive an email once a decision has been made

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
Questions? Contact ${config.platform.supportEmail}
    `,
  }),

  /**
   * Profile updated notification
   */
  profileUpdated: (firstName: string, changedFields: string[]): { subject: string; html: string; text: string } => ({
    subject: `Your Easykonnet Profile Has Been Updated`,
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>Your profile was updated successfully. The following fields were changed:</p>
      <ul style="color: #555;">
        ${changedFields.map(f => `<li><strong>${f}</strong></li>`).join('')}
      </ul>
      <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Contact support immediately at ${config.platform.supportEmail}.</p>
      ${emailFooter()}
    `),
    text: `
Hello ${firstName},

Your profile was updated successfully. The following fields were changed:
${changedFields.map(f => `- ${f}`).join('\n')}

⚠️ Not you? Contact support immediately at ${config.platform.supportEmail}.

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),

  /**
   * Email change OTP
   */
  emailChangeOtp: (firstName: string, newEmail: string, otp: string): { subject: string; html: string; text: string } => ({
    subject: `Confirm Your New Email Address — Easykonnet`,
    html: emailWrapper(`
      <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
      <p>We received a request to change your account email to <strong>${newEmail}</strong>.</p>
      <p>Use the code below to confirm this change:</p>
      <div style="background: #f0f7f7; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px dashed ${BRAND_COLOR};">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: ${BRAND_COLOR};">${otp}</span>
      </div>
      <p style="color: #666; font-size: 14px;">This code expires in <strong>10 minutes</strong>.</p>
      <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Your current email is still active. Contact support at ${config.platform.supportEmail} immediately.</p>
      ${emailFooter()}
    `),
    text: `
Hello ${firstName},

We received a request to change your account email to ${newEmail}.

Your confirmation code: ${otp}

This code expires in 10 minutes.

⚠️ Not you? Your current email is still active. Contact support at ${config.platform.supportEmail} immediately.

© ${new Date().getFullYear()} Easykonnet. All rights reserved.
    `,
  }),
};

/**
 * Send email
 */
interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const sendEmail = async (options: SendEmailOptions): Promise<boolean> => {
  try {
    const { error } = await resend.emails.send({
      from: `${config.email.fromName} <${config.email.fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    if (error) {
      console.error('❌ Email sending failed:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ Email sending failed:', error);
    return false;
  }
};

/**
 * Send verification OTP email
 */
export const sendVerificationEmail = async (
  email: string,
  firstName: string,
  otp: string
): Promise<boolean> => {
  const template = emailTemplates.verificationOtp(otp, firstName);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send password reset OTP email
 */
export const sendPasswordResetEmail = async (
  email: string,
  firstName: string,
  otp: string
): Promise<boolean> => {
  const template = emailTemplates.passwordResetOtp(otp, firstName);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send login alert email
 */
export const sendLoginAlertEmail = async (
  email: string,
  firstName: string,
  ip: string
): Promise<boolean> => {
  const time = new Date().toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
  });
  const template = emailTemplates.loginAlert(firstName, ip, time);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send provider approved email
 */
export const sendProviderApprovedEmail = async (
  email: string,
  firstName: string,
  businessName: string
): Promise<boolean> => {
  const template = emailTemplates.providerApproved(firstName, businessName);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send provider rejected email
 */
export const sendProviderRejectedEmail = async (
  email: string,
  firstName: string,
  businessName: string,
  reason: string
): Promise<boolean> => {
  const template = emailTemplates.providerRejected(firstName, businessName, reason);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send provider submission received email
 */
export const sendProviderSubmissionEmail = async (
  email: string,
  firstName: string,
  businessName: string
): Promise<boolean> => {
  const template = emailTemplates.providerSubmissionReceived(firstName, businessName);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send profile updated notification email
 */
export const sendProfileUpdatedEmail = async (
  email: string,
  firstName: string,
  changedFields: string[]
): Promise<boolean> => {
  const template = emailTemplates.profileUpdated(firstName, changedFields);
  return sendEmail({
    to: email,
    ...template,
  });
};

/**
 * Send email change OTP to the NEW email address
 */
export const sendEmailChangeOtpEmail = async (
  newEmail: string,
  firstName: string,
  otp: string
): Promise<boolean> => {
  const template = emailTemplates.emailChangeOtp(firstName, newEmail, otp);
  return sendEmail({
    to: newEmail,
    ...template,
  });
};

export default {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail,
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
  sendProviderSubmissionEmail,
  sendProfileUpdatedEmail,
  sendEmailChangeOtpEmail,
};
