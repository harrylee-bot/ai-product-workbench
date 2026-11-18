import { createTransport } from "nodemailer";

export function verificationEmailOptions(environment: NodeJS.ProcessEnv, authOrigin: string) {
  const address = environment.WORKBENCH_AUTH_MAIL_FROM?.trim();
  const configuredUrl = environment.WORKBENCH_AUTH_SMTP_URL?.trim();
  if (!address && !configuredUrl) return undefined;
  if (!configuredUrl || !address || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(address)) {
    throw new Error("Configure WORKBENCH_AUTH_SMTP_URL and a single WORKBENCH_AUTH_MAIL_FROM address");
  }
  const smtp = URL.parse(configuredUrl);
  if (!smtp || !["smtp:", "smtps:"].includes(smtp.protocol) || !smtp.hostname
      || !["", "/"].includes(smtp.pathname) || smtp.search || smtp.hash) {
    throw new Error("WORKBENCH_AUTH_SMTP_URL must be an SMTP or SMTPS server URL");
  }
  const secure = smtp.protocol === "smtps:";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(smtp.hostname);
  const transport = createTransport({
    host: smtp.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(smtp.port || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure && !loopback,
    ...(smtp.username && { auth: { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) } }),
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    expiresIn: 60 * 60,
    async sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
      if (new URL(url).origin !== authOrigin) throw new Error("Unexpected verification link origin");
      await transport.sendMail({
        from: { name: "产品工作台", address },
        to: { name: "", address: user.email },
        subject: "验证产品工作台账户邮箱",
        text: `请打开以下链接验证你的账户邮箱。链接在一小时内有效。\n\n${url}\n\n验证完成后请返回原页面接受邀请。`,
      });
    },
  };
}
