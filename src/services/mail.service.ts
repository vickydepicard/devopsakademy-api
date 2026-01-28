import nodemailer from "nodemailer";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

const createTransporter = () => {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASSWORD) {
    throw new Error("MAIL credentials missing");
  }

  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    secure: process.env.MAIL_SECURE === "true",
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD,
    },
  });
};

export const sendEmail = async ({ to, subject, html }: SendEmailParams) => {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
};
