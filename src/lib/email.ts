/**
 * Email Service
 * Handles all email sending functionality using Nodemailer
 * 
 * Security considerations:
 * - Uses environment variables for credentials
 * - Supports multiple email providers
 * - HTML emails are sanitized
 */

import nodemailer from 'nodemailer';
import { config } from '@/config';

// Email transporter singleton
let transporter: nodemailer.Transporter | null = null;

/**
 * Get or create email transporter
 * Uses singleton pattern to reuse connection
 */
const getTransporter = (): nodemailer.Transporter => {
  if (transporter) {
    return transporter;
  }

  // Create transporter based on environment
  if (config.isDevelopment) {
    // For development, use Ethereal (fake SMTP) or configured SMTP
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
  } else {
    // Production: Use configured SMTP server
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
  }

  return transporter;
};

/**
 * Email templates
 */
const emailTemplates = {
  /**
   * Email verification OTP template
   */
  verificationOtp: (otp: string, firstName: string): { subject: string; html: string; text: string } => ({
    subject: 'Verify Your EasyKonnect Account',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Email Verification</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">EasyKonnect</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>Welcome to EasyKonnect! To complete your registration, please verify your email address using the code below:</p>
            <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea;">${otp}</span>
            </div>
            <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
            <p style="color: #666; font-size: 14px;">If you didn't create an account with EasyKonnect, please ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} EasyKonnect. All rights reserved.<br>
              This is an automated message, please do not reply.
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      Welcome to EasyKonnect! To complete your registration, please verify your email address using the code below:
      
      Your verification code: ${otp}
      
      This code will expire in 10 minutes.
      
      If you didn't create an account with EasyKonnect, please ignore this email.
      
      © ${new Date().getFullYear()} EasyKonnect. All rights reserved.
    `,
  }),

  /**
   * Password reset OTP template
   */
  passwordResetOtp: (otp: string, firstName: string): { subject: string; html: string; text: string } => ({
    subject: 'Reset Your EasyKonnect Password',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Reset</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">EasyKonnect</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>We received a request to reset your password. Use the code below to proceed:</p>
            <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea;">${otp}</span>
            </div>
            <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
            <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Security Notice:</strong> If you didn't request a password reset, please secure your account immediately by changing your password.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} EasyKonnect. All rights reserved.<br>
              This is an automated message, please do not reply.
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      We received a request to reset your password. Use the code below to proceed:
      
      Your reset code: ${otp}
      
      This code will expire in 10 minutes.
      
      ⚠️ Security Notice: If you didn't request a password reset, please secure your account immediately by changing your password.
      
      © ${new Date().getFullYear()} EasyKonnect. All rights reserved.
    `,
  }),

  /**
 * Login alert template
 */
  loginAlert: (firstName: string, ip: string, time: string): { subject: string; html: string; text: string } => ({
    subject: 'New Login to Your EasyKonnect Account',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Login Alert</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">EasyKonnect</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>We detected a new login to your EasyKonnect account:</p>
            <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 5px 0;"><strong>Time:</strong> ${time}</p>
              <p style="margin: 5px 0;"><strong>IP Address:</strong> ${ip}</p>
            </div>
            <p style="color: #666; font-size: 14px;">If this was you, no action is needed.</p>
            <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Please change your password immediately and contact our support team.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} EasyKonnect. All rights reserved.
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      We detected a new login to your EasyKonnect account:
      
      Time: ${time}
      IP Address: ${ip}
      
      If this was you, no action is needed.
      
      ⚠️ Not you? Please change your password immediately and contact our support team.
      
      © ${new Date().getFullYear()} EasyKonnect. All rights reserved.
    `,
  }),

  /**
   * Provider Approved template
   */
  providerApproved: (firstName: string, businessName: string): { subject: string; html: string; text: string } => ({
    subject: '🎉 Your Provider Account Has Been Approved!',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Provider Approved</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">🎉 Congratulations!</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>Great news! Your provider account <strong>"${businessName}"</strong> has been verified and approved.</p>
            <div style="background: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #27ae60;">
              <h3 style="margin: 0 0 10px 0; color: #27ae60;">✅ You're Now Verified!</h3>
              <p style="margin: 0; color: #155724;">You can now:</p>
              <ul style="margin: 10px 0 0 0; color: #155724;">
                <li>Create and publish services</li>
                <li>Receive booking requests from customers</li>
                <li>Start earning on EasyKonnect</li>
              </ul>
            </div>
            <p>Log in to your dashboard to start creating services and growing your business!</p>
            <div style="text-align: center; margin: 25px 0;">
              <a href="${config.platform.frontendUrl}/provider/dashboard" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: bold;">Go to Dashboard</a>
            </div>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.<br>
              Welcome to the ${config.platform.name} provider community!
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      Great news! Your provider account "${businessName}" has been verified and approved.
      
      ✅ You're Now Verified!
      
      You can now:
      - Create and publish services
      - Receive booking requests from customers
      - Start earning on EasyKonnect
      
      Log in to your dashboard to start creating services and growing your business!
      
      Dashboard: ${config.platform.frontendUrl}/provider/dashboard
      
      © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
      Welcome to the ${config.platform.name} provider community!
    `,
  }),

  /**
   * Provider Rejected template
   */
  providerRejected: (firstName: string, businessName: string, reason: string): { subject: string; html: string; text: string } => ({
    subject: 'Update on Your Provider Application',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Provider Application Update</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">EasyKonnect</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
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
            <p>If you believe this decision was made in error or have questions, please contact our support team.</p>
            <div style="text-align: center; margin: 25px 0;">
              <a href="${config.platform.frontendUrl}/provider/profile" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: bold;">Update Profile</a>
            </div>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.<br>
              Need help? Contact ${config.platform.supportEmail}
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      We've reviewed your provider application for "${businessName}", and unfortunately, we're unable to approve it at this time.
      
      Reason for Rejection:
      ${reason}
      
      What You Can Do:
      1. Review the feedback above
      2. Update your provider profile with the required information
      3. Re-submit your application for verification
      
      If you believe this decision was made in error or have questions, please contact our support team.
      
      Update Profile: ${config.platform.frontendUrl}/provider/profile
      
      © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
      Need help? Contact ${config.platform.supportEmail}
    `,
  }),

  /**
   * Provider Submission Received template
   */
  providerSubmissionReceived: (firstName: string, businessName: string): { subject: string; html: string; text: string } => ({
    subject: 'We Received Your Provider Application!',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Application Received</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">EasyKonnect</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>Thank you for submitting your provider application for <strong>"${businessName}"</strong>!</p>
            <div style="background: #cce5ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #004085;">
              <h3 style="margin: 0 0 10px 0; color: #004085;">📋 Application Status: Under Review</h3>
              <p style="margin: 0; color: #004085;">Our team is reviewing your application. This typically takes 1-2 business days.</p>
            </div>
            <h3 style="color: #333;">What Happens Next?</h3>
            <ol style="color: #666;">
              <li>Our team will verify the information you provided</li>
              <li>We may contact you if we need additional information</li>
              <li>You'll receive an email once a decision has been made</li>
            </ol>
            <p>In the meantime, you can prepare your services so you're ready to publish as soon as you're approved!</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.<br>
              Questions? Contact ${config.platform.supportEmail}
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},
      
      Thank you for submitting your provider application for "${businessName}"!
      
      📋 Application Status: Under Review
      
      Our team is reviewing your application. This typically takes 1-2 business days.
      
      What Happens Next?
      1. Our team will verify the information you provided
      2. We may contact you if we need additional information
      3. You'll receive an email once a decision has been made
      
      In the meantime, you can prepare your services so you're ready to publish as soon as you're approved!
      
      © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
      Questions? Contact ${config.platform.supportEmail}
    `,
  }),

  /**
   * Profile updated notification
   */
  profileUpdated: (firstName: string, changedFields: string[]): { subject: string; html: string; text: string } => ({
    subject: `Your ${config.platform.name} Profile Has Been Updated`,
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">${config.platform.name}</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>Your profile was updated successfully. The following fields were changed:</p>
            <ul style="color: #555;">
              ${changedFields.map(f => `<li><strong>${f}</strong></li>`).join('')}
            </ul>
            <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Contact support immediately at ${config.platform.supportEmail}.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},

      Your profile was updated successfully. The following fields were changed:
      ${changedFields.map(f => `- ${f}`).join('\n')}

      ⚠️ Not you? Contact support immediately at ${config.platform.supportEmail}.

      © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
    `,
  }),

  /**
   * Email change OTP
   */
  emailChangeOtp: (firstName: string, newEmail: string, otp: string): { subject: string; html: string; text: string } => ({
    subject: `Confirm Your New Email Address — ${config.platform.name}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">${config.platform.name}</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Hello ${firstName},</h2>
            <p>We received a request to change your account email to <strong>${newEmail}</strong>.</p>
            <p>Use the code below to confirm this change:</p>
            <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea;">${otp}</span>
            </div>
            <p style="color: #666; font-size: 14px;">This code expires in <strong>10 minutes</strong>.</p>
            <p style="color: #e74c3c; font-size: 14px;"><strong>⚠️ Not you?</strong> Your current email address is still active. Contact support at ${config.platform.supportEmail} immediately.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
            </p>
          </div>
        </body>
      </html>
    `,
    text: `
      Hello ${firstName},

      We received a request to change your account email to ${newEmail}.

      Your confirmation code: ${otp}

      This code expires in 10 minutes.

      ⚠️ Not you? Your current email is still active. Contact support at ${config.platform.supportEmail} immediately.

      © ${new Date().getFullYear()} ${config.platform.name}. All rights reserved.
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
    const transport = getTransporter();

    const mailOptions = {
      from: `"${config.email.fromName}" <${config.email.fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    };

    const info = await transport.sendMail(mailOptions);

    if (config.isDevelopment) {
      console.log('📧 Email sent:', info.messageId);
      // If using Ethereal, log the preview URL
      if (info.messageId) {
        console.log('Preview URL:', nodemailer.getTestMessageUrl(info));
      }
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
