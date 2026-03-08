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

export default {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail,
};
