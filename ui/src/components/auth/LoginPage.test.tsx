import { fireEvent, renderWithLocale, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

describe("LoginPage local auth", () => {
  it("renders local login and toggles to invite registration", () => {
    renderWithLocale(
      <LoginPage
        authMode="local"
        registrationPolicy="invite"
        onAuthenticated={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Sign in" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    expect(screen.getByLabelText("Invite code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
  });
});
