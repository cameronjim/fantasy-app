import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const sesClient = new SESv2Client({ region: process.env.AWS_REGION ?? 'us-east-1' });

interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

/**
 * Sends an email via AWS SES.
 *
 * Required env vars:
 *   FROM_EMAIL — a verified sender identity in SES (e.g. "noreply@cameronjim.com")
 *
 * Required IAM: the Lambda execution role needs ses:SendEmail (set in serverless.yml).
 */
export async function sendEmail({ to, subject, html, text }: SendEmailArgs): Promise<void> {
  const from = process.env.FROM_EMAIL;
  if (!from) {
    throw new Error('FROM_EMAIL is not configured');
  }

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    })
  );
}

/** Builds the password-reset email content (subject + html + plain text). */
export function passwordResetEmail(resetUrl: string, username: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Reset your Fantasy NBA password';
  const safeResetUrl = escapeHtml(resetUrl);
  const safeUsername = escapeHtml(username);

  const text = [
    `Hi ${username},`,
    '',
    'We received a request to reset your Fantasy NBA password.',
    'Click the link below to choose a new password. It expires in 1 hour.',
    '',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:32px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:12px; padding:32px; max-width:480px;">
        <tr><td>
          <h2 style="color:#1f2937; margin:0 0 16px; font-size:22px;">Reset your password</h2>
          <p style="color:#4b5563; line-height:1.6; margin:0 0 16px;">Hi ${safeUsername}, we received a request to reset your Fantasy NBA password.</p>
          <p style="color:#4b5563; line-height:1.6; margin:0 0 24px;">Click the button below to choose a new password. The link expires in 1 hour.</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#2563eb; border-radius:8px;">
            <a href="${safeResetUrl}" style="display:inline-block; color:#ffffff; text-decoration:none; padding:12px 28px; font-weight:600; font-size:15px;">Reset Password</a>
          </td></tr></table>
          <p style="color:#9ca3af; font-size:13px; margin:32px 0 6px;">Or copy this link into your browser:</p>
          <p style="color:#6b7280; font-size:13px; word-break:break-all; margin:0;">${safeResetUrl}</p>
          <hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0 16px;">
          <p style="color:#9ca3af; font-size:12px; line-height:1.5; margin:0;">If you didn't request a password reset, you can safely ignore this email. Your password won't change.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}
