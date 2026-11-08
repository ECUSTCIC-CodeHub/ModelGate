"use client";

import { useState } from "react";

/**
 * /dsh/authorize 的确认按钮。确认动作是 POST（会新建密钥，不可幂等），
 * 所以页面用一份隐藏表单提交，由服务端 302 把浏览器带到 DSH 的本机回调。
 */
export function AuthorizeForm({
  port,
  session,
  username,
}: {
  port: string;
  session: string | null;
  username: string;
}) {
  const [loading, setLoading] = useState(false);

  const handleSubmit = () => {
    setLoading(true);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: "48px 40px",
          borderRadius: "16px",
          background: "#fff",
          boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
          maxWidth: "420px",
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: "22px", fontWeight: 600 }}>
          登录到 DeepSeek Harness
        </h1>
        <p style={{ color: "#666", margin: "0 0 24px", fontSize: "14px", lineHeight: 1.6 }}>
          当前已登录账号：<strong style={{ color: "#333" }}>{username}</strong>
          <br />
          确认后将为本次接入新建一枚网关密钥，并投递到本机 DSH。
        </p>
        <form method="post" action="/api/user/dsh/authorize-confirm" onSubmit={handleSubmit}>
            <input type="hidden" name="port" value={port} />
            {session ? <input type="hidden" name="session" value={session} /> : null}
          <button
            type="submit"
            disabled={loading}
            style={{
              font: "inherit",
              fontSize: "15px",
              padding: "12px 32px",
              borderRadius: "8px",
              border: "none",
              background: loading ? "#aaa" : "#2f9e63",
              color: "#fff",
              cursor: loading ? "default" : "pointer",
              fontWeight: 500,
              transition: "background 0.2s",
            }}
          >
            {loading ? "正在发送…" : "确认登录到 DSH"}
          </button>
        </form>
        <p style={{ color: "#999", margin: "20px 0 0", fontSize: "12px" }}>
          密钥不会显示在此页面，仅通过本机回调安全传递。
        </p>
      </div>
    </div>
  );
}
