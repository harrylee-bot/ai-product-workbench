"use client";

import { ArrowRightIcon, MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const SPOTLIGHT_R = 260;

const BG_IMAGE_1 =
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260609_195923_b0ba8ace-1d1d-4f2c-9a28-1ab84b330680.png&w=1280&q=85";
const BG_IMAGE_2 =
  "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260609_201152_bba90a12-bf12-459f-91f0-51f237dbaf3b.png&w=1280&q=85";

const navItems = [
  {
    id: "requirements",
    label: "需求",
  },
  {
    id: "prototype",
    label: "原型",
  },
  {
    id: "knowledge",
    label: "知识库",
  },
  {
    id: "cases",
    label: "案例",
  },
  {
    id: "rules",
    label: "规则",
  },
] as const;

type Point = {
  x: number;
  y: number;
};

type AuthSpotlightShellProps = {
  children: ReactNode;
};

export function AuthSpotlightShell({ children }: AuthSpotlightShellProps) {
  const pathname = usePathname();
  const isRegister = pathname?.includes("/register");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [activeTabId, setActiveTabId] = useState<(typeof navItems)[number]["id"]>(
    navItems[0].id
  );
  const authCtaLabel = isRegister ? "创建账号" : "登录";

  useEffect(() => {
    if (!authOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAuthOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [authOpen]);

  return (
    <div
      className="dark min-h-screen bg-white tracking-[-0.02em]"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      <section
        className="relative h-screen w-full overflow-hidden bg-black"
        style={{ height: "100dvh" }}
      >
        <div
          className="hero-zoom absolute inset-0 z-10 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${BG_IMAGE_1})` }}
        />
        <RevealLayer image={BG_IMAGE_2} />
        <div className="pointer-events-none absolute inset-0 z-40 bg-[linear-gradient(180deg,rgba(0,0,0,0.28)_0%,rgba(0,0,0,0.08)_42%,rgba(0,0,0,0.52)_100%)]" />

        <nav className="fixed top-0 right-0 left-0 z-[100] flex items-center justify-between p-4 sm:p-5">
          <Link
            className="flex items-center gap-2 text-white"
            href="/login"
            onClick={() => {
              setAuthOpen(false);
              setMobileNavOpen(false);
            }}
          >
            <svg
              aria-hidden="true"
              className="size-[26px] shrink-0"
              fill="#ffffff"
              viewBox="0 0 256 256"
            >
              <path d="M 256 256 L 128 256 L 0 128 L 128 128 Z M 256 128 L 128 128 L 0 0 L 128 0 Z" />
            </svg>
            <span className="text-2xl">产品工作台</span>
          </Link>

          <div
            aria-label="产品工作台模块"
            className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-white/30 bg-white/20 px-2 py-2 backdrop-blur-md md:flex"
            role="tablist"
          >
            {navItems.map((item) => (
              <button
                aria-selected={activeTabId === item.id}
                className={cn(
                  "rounded-full px-4 py-1.5 font-medium text-sm transition-colors",
                  activeTabId === item.id
                    ? "bg-white text-gray-950"
                    : "text-white/80 hover:bg-white/20 hover:text-white"
                )}
                key={item.id}
                onClick={() => setActiveTabId(item.id)}
                role="tab"
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <button
              className="rounded-full bg-white px-6 py-2.5 font-semibold text-gray-900 text-sm transition-colors hover:bg-gray-100"
              onClick={() => setAuthOpen(true)}
              type="button"
            >
              {authCtaLabel}
            </button>
          </div>

          <button
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? "关闭导航" : "打开导航"}
            className="flex size-10 items-center justify-center rounded-full border border-white/25 bg-white/15 text-white backdrop-blur-md transition-colors hover:bg-white/25 md:hidden"
            onClick={() => setMobileNavOpen((open) => !open)}
            type="button"
          >
            {mobileNavOpen ? (
              <XIcon className="size-4" />
            ) : (
              <MenuIcon className="size-4" />
            )}
          </button>

          {mobileNavOpen && (
            <div className="absolute top-16 right-4 left-4 flex flex-col gap-1 rounded-lg border border-white/25 bg-black/55 p-2 text-white shadow-2xl backdrop-blur-xl md:hidden">
              {navItems.map((item) => (
                <button
                  aria-selected={activeTabId === item.id}
                  className={cn(
                    "rounded-md px-3 py-2 text-left text-sm transition-colors",
                    activeTabId === item.id
                      ? "bg-white text-gray-950"
                      : "text-white/80 hover:bg-white/10 hover:text-white"
                  )}
                  key={item.id}
                  onClick={() => {
                    setActiveTabId(item.id);
                    setMobileNavOpen(false);
                  }}
                  role="tab"
                  type="button"
                >
                  <span>{item.label}</span>
                </button>
              ))}
              <button
                className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-white px-3 py-2 font-semibold text-gray-950 text-sm"
                onClick={() => {
                  setAuthOpen(true);
                  setMobileNavOpen(false);
                }}
                type="button"
              >
                {authCtaLabel}
                <ArrowRightIcon className="size-3.5" />
              </button>
            </div>
          )}
        </nav>

        {authOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 py-20">
            <button
              aria-label="关闭登录注册窗口"
              className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
              onClick={() => setAuthOpen(false)}
              type="button"
            />
            <div className="hero-anim hero-reveal relative w-full max-w-[360px] rounded-[16px] border border-white/12 bg-black/42 px-5 pt-14 pb-5 text-white shadow-[0_24px_80px_-36px_rgba(0,0,0,0.95)] ring-1 ring-white/[0.05] backdrop-blur-xl sm:px-6 sm:pt-14 sm:pb-6">
              <button
                aria-label="关闭登录注册窗口"
                className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                onClick={() => setAuthOpen(false)}
                type="button"
              >
                <XIcon className="size-4" />
              </button>
              {children}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function RevealLayer({ image }: { image: string }) {
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reveal = revealRef.current;
    if (!reveal) return;

    const mouse: Point = { x: -999, y: -999 };
    const smooth: Point = { x: -999, y: -999 };
    let rafId: number | null = null;

    const handleMove = (event: MouseEvent | PointerEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
    };

    const drawMask = () => {
      const maskImage = `radial-gradient(circle ${SPOTLIGHT_R}px at ${smooth.x}px ${smooth.y}px, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 40%, rgba(0,0,0,0.75) 60%, rgba(0,0,0,0.4) 75%, rgba(0,0,0,0.12) 88%, rgba(0,0,0,0) 100%)`;
      reveal.style.maskImage = maskImage;
      reveal.style.maskRepeat = "no-repeat";
      reveal.style.maskSize = "100% 100%";
      reveal.style.setProperty("-webkit-mask-image", maskImage);
      reveal.style.setProperty("-webkit-mask-repeat", "no-repeat");
      reveal.style.setProperty("-webkit-mask-size", "100% 100%");
    };

    const tick = () => {
      smooth.x += (mouse.x - smooth.x) * 0.1;
      smooth.y += (mouse.y - smooth.y) * 0.1;
      drawMask();
      rafId = window.requestAnimationFrame(tick);
    };

    drawMask();
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("pointermove", handleMove);
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("pointermove", handleMove);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 bg-cover bg-center bg-no-repeat"
      ref={revealRef}
      style={{
        backgroundImage: `url(${image})`,
        maskImage: "radial-gradient(circle 0 at -999px -999px, transparent 0)",
        WebkitMaskImage:
          "radial-gradient(circle 0 at -999px -999px, transparent 0)",
      }}
    />
  );
}
