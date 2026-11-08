"use client";

import { useState } from "react";

/**
 * The confirm button on the /dsh/authorize page. Clicking it navigates to
 * GET /api/user/dsh/authorize-confirm?port=XXX&session=YYY, which generates
 * a key + code and 302-redirects the browser to the DSH localhost callback.
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

  const handleConfirm = () => {
    setLoading(true);
    const params = new URLSearchParams({ port });
    if (session) params.set("session", session);
    // Full-page navigation → the server responds with a 302 redirect
    window.location.href = `/api/user/dsh/authorize-confirm?${params.toString()}`;
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
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>🔑</div>
        <h1 style={{ margin: "0 0 8px", fontSize: "22px", fontWeight: 600 }}>
          登录到 DeepSeek Harness
        </h1>
        <p style={{ color: "#666", margin: "0 0 24px", fontSize: "14px", lineHeight: 1.6 }}>
          当前已登录账号：<strong style={{ color: "#333" }}>{username}</strong>
          <br />
          确认后，将自动把 CIC 网关密钥发送到本机 DSH。
        </p>
        <button
          type="button"
          onClick={handleConfirm}
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
        <p style={{ color: "#999", margin: "20px 0 0", fontSize: "12px" }}>
          密钥不会显示在此页面，仅通过本机回调安全传递。
        </p>
      </div>
    </div>
  );
}
