// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { toast as sonnerToast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthForm } from "./auth-form";
import { AuthSubmitButton } from "./auth-submit-button";
import { AuthToaster, authToast } from "./auth-toast";

class ResizeObserverMock implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  sonnerToast.dismiss();
  cleanup();
});

describe("auth-owned presentation components", () => {
  it("preserves the login form DOM and presentation contract", () => {
    const { container } = render(
      <AuthForm action={() => undefined} defaultAccount="owner">
        <button type="submit">登录</button>
      </AuthForm>,
    );
    const form = container.querySelector("form");
    const account = screen.getByLabelText("用户名或邮箱");
    const password = screen.getByLabelText("密码");

    expectClasses(form, "flex", "flex-col", "gap-4");
    expect(Array.from(form?.children ?? []).map((child) => child.tagName)).toEqual([
      "DIV",
      "DIV",
      "BUTTON",
    ]);
    expect(account.getAttribute("autocomplete")).toBe("username");
    expect(document.activeElement).toBe(account);
    expect(account.getAttribute("placeholder")).toBe("username");
    expect((account as HTMLInputElement).required).toBe(true);
    expect((account as HTMLInputElement).type).toBe("text");
    expect((account as HTMLInputElement).value).toBe("owner");
    expectClasses(
      account,
      "h-10",
      "rounded-lg",
      "border-border/50",
      "bg-muted/50",
      "text-sm",
      "transition-colors",
      "focus:border-foreground/20",
      "focus:bg-muted",
    );
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("placeholder")).toBe("••••••••");
    expect((password as HTMLInputElement).required).toBe(true);
    expect((password as HTMLInputElement).type).toBe("password");
    expectClasses(
      password,
      "h-10",
      "rounded-lg",
      "border-border/50",
      "bg-muted/50",
      "text-sm",
      "transition-colors",
      "focus:border-foreground/20",
      "focus:bg-muted",
    );
  });

  it("preserves the submit button success state and loader animation", () => {
    const { container, rerender } = render(
      <AuthSubmitButton isSuccessful={false}>登录</AuthSubmitButton>,
    );
    const button = screen.getByRole("button", { name: /登录/ });

    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect((button as HTMLButtonElement).type).toBe("submit");
    expectClasses(button, "relative");
    expectClasses(screen.getByText("提交表单"), "sr-only");

    rerender(<AuthSubmitButton isSuccessful>登录</AuthSubmitButton>);

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expectClasses(screen.getByText("加载中"), "sr-only");
    expectClasses(
      container.querySelector("span"),
      "absolute",
      "right-4",
      "animate-spin",
    );
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(
      Array.from(container.querySelectorAll("path"), (path) => path.getAttribute("d")),
    ).toEqual([
      "M8 0V4",
      "M8 16V12",
      "M3.29773 1.52783L5.64887 4.7639",
      "M12.7023 1.52783L10.3511 4.7639",
      "M12.7023 14.472L10.3511 11.236",
      "M3.29773 14.472L5.64887 11.236",
      "M15.6085 5.52783L11.8043 6.7639",
      "M0.391602 10.472L4.19583 9.23598",
      "M15.6085 10.4722L11.8043 9.2361",
      "M0.391602 5.52783L4.19583 6.7639",
    ]);
  });

  it("renders auth toast feedback through the auth-scoped toaster", async () => {
    render(<AuthToaster />);

    await act(async () => {
      authToast({ type: "error", description: "账号或密码不正确" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toast = await screen.findByTestId("toast");
    const toaster = document.querySelector("[data-sonner-toaster]");
    const toastItem = toast.closest("[data-sonner-toast]");

    expect(toaster?.getAttribute("data-theme")).toBe("dark");
    expect(toaster?.getAttribute("data-y-position")).toBe("top");
    expect(toaster?.getAttribute("data-x-position")).toBe("center");
    expectClasses(
      toastItem,
      "!bg-card",
      "!text-foreground",
      "!border-border/70",
      "!shadow-[var(--shadow-float)]",
      "!backdrop-blur-xl",
    );
    expectClasses(
      toast,
      "flex",
      "toast-mobile:w-fit",
      "w-full",
      "flex-row",
      "gap-3",
      "rounded-lg",
      "bg-card",
      "border",
      "border-border/50",
      "shadow-[var(--shadow-float)]",
      "p-3",
      "items-center",
    );
    expectClasses(
      toast.querySelector("[data-type='error']"),
      "data-[type=error]:text-red-600",
    );
    expectClasses(screen.getByText("账号或密码不正确"), "text-sm", "text-foreground");
  });
});

function expectClasses(element: Element | null, ...classNames: string[]) {
  expect(element).not.toBeNull();
  for (const className of classNames) {
    expect(element?.classList.contains(className), `missing class ${className}`).toBe(true);
  }
}
