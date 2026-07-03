import Link from "next/link";
import { ArrowRight, ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Footer } from "@/components/footer";
import { getGatewaySettings } from "@/lib/core/settings";

export const dynamic = "force-dynamic";

const REPO_URL = "https://cnb.cool/ecustcic/ModelGate";

export const metadata = {
  title: "ModelGate | 多租户 LLM 网关",
  description:
    "ModelGate 是一个基于 Next.js + SQLite 的多租户 LLM 网关与管理控制台，统一协议入口、治理能力和调用审计。",
};

export default async function HomePage() {
  const settings = await getGatewaySettings();
  const wideLogo = settings.logo_url;
  const squareLogo = settings.logo_square_url;
  return (
    <main className="min-h-screen">
      <section className="relative min-h-screen overflow-hidden">
        <header className="absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-6xl items-center justify-end px-6 py-6 text-sm">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[var(--color-foreground-muted)] transition-colors hover:text-[var(--color-accent)]"
          >
            查看项目
            <ExternalLink className="size-4" />
          </a>
        </header>

        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center justify-center px-6 py-24 text-center">
          <div className="flex max-w-4xl flex-col items-center">
            <p className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs tracking-wide text-[var(--color-foreground-muted)] shadow-sm backdrop-blur">
              <Sparkles className="mr-2 size-4 text-[var(--color-accent)]" />
              多租户 LLM 网关管理控制台
            </p>
            {(wideLogo || squareLogo) ? (
              <div className="mt-7 flex justify-center">
                {wideLogo && squareLogo ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={wideLogo} alt="Logo" className="hidden h-14 w-auto object-contain sm:h-16 lg:h-20 md:block" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={squareLogo} alt="Logo" className="h-14 w-auto object-contain sm:h-16 md:hidden" />
                  </>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={wideLogo || squareLogo} alt="Logo" className="h-14 w-auto object-contain sm:h-16 lg:h-20" />
                )}
              </div>
            ) : (
              <h1 className="mt-7 text-5xl font-semibold leading-tight text-[var(--color-foreground)] sm:text-6xl lg:text-7xl">
                ModelGate
              </h1>
            )}
            <p className="mt-5 max-w-3xl text-lg leading-8 text-[var(--color-foreground-secondary)] sm:text-xl">
              统一管理多协议模型入口、上游渠道、用户权限、限流配额与调用日志，让团队以一致方式接入和治理 LLM 服务。
            </p>
            <div className="mt-8 flex items-center justify-center">
              <Button asChild size="lg" className="min-w-36">
                <Link href="/login">
                  立即进入
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
            <div className="mt-10 grid w-full gap-4 text-sm text-[var(--color-foreground-muted)] sm:grid-cols-3">
              <div className="glass rounded-lg px-5 py-4">
                <p className="font-medium text-[var(--color-foreground)]">多渠道路由</p>
                <p className="mt-1">权重分配、熔断、模型别名</p>
              </div>
              <div className="glass rounded-lg px-5 py-4">
                <p className="font-medium text-[var(--color-foreground)]">租户治理</p>
                <p className="mt-1">用户组、密钥、模型白名单</p>
              </div>
              <div className="glass rounded-lg px-5 py-4">
                <p className="font-medium text-[var(--color-foreground)]">调用审计</p>
                <p className="mt-1">Token 用量、延迟、状态追踪</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <Footer />
    </main>
  );
}
