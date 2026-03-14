/**
 * Email Service Integration Tests
 * Tests SMTP connection and email sending
 * 
 * Requires: SMTP_* env vars set in .env
 * Uses Nodemailer verify() to test without actually sending
 */

import nodemailer from 'nodemailer';
import { config } from '@/config';

describe('Email Service Integration', () => {
  // ==================
  // Configuration
  // ==================
  describe('Configuration', () => {
    it('should have SMTP credentials configured', () => {
      expect(config.email.host).toBeTruthy();
      expect(config.email.user).toBeTruthy();
      expect(config.email.pass).toBeTruthy();
    });

    it('should have a valid from address', () => {
      expect(config.email.fromAddress).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });
  });

  // ==================
  // SMTP Connection
  // ==================
  describe('SMTP Connection', () => {
    it('should verify SMTP connection successfully', async () => {
      const transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: {
          user: config.email.user,
          pass: config.email.pass,
        },
      });

      await expect(transporter.verify()).resolves.toBe(true);
    }, 15000);
  });

  // ==================
  // Email Template Generation (no SMTP needed)
  // ==================
  describe('Email Functions (Unit)', () => {
    it('should export required email functions', async () => {
      const emailLib = await import('@/lib/email');
      expect(typeof emailLib.sendEmail).toBe('function');
      expect(typeof emailLib.sendVerificationEmail).toBe('function');
      expect(typeof emailLib.sendPasswordResetEmail).toBe('function');
      expect(typeof emailLib.sendLoginAlertEmail).toBe('function');
      expect(typeof emailLib.sendProviderApprovedEmail).toBe('function');
      expect(typeof emailLib.sendProviderRejectedEmail).toBe('function');
    });
  });
});
