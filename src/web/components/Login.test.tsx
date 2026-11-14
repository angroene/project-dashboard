import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Login } from "./Login";
import { mockFetch, renderWithProviders } from "../test/utils";
import { qk } from "../api/client";

describe("Login", () => {
  it("keeps Sign in disabled until a token is typed, then posts it and refreshes the session", async () => {
    const api = mockFetch({ "POST /api/auth/login": { ok: true } });
    const { client } = renderWithProviders(<Login productName="Test Dashboard" />);
    client.setQueryData(qk.session, { authenticated: false });
    expect(screen.getByText(/Test Dashboard requires an access token/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sign in" });
    expect(button).toBeDisabled();

    const input = screen.getByLabelText("Access token");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.type(input, "s3cret");
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(api.count("POST", "/api/auth/login")).toBe(1));
    const call = api.calls[0];
    expect(call.body).toEqual({ token: "s3cret" });
    expect(call.headers["x-pcc-request"]).toBe("1");
    await waitFor(() => expect(client.getQueryState(qk.session)?.isInvalidated).toBe(true));
    expect(input).toHaveValue("");
  });

  it("shows the server message as an alert and keeps the token for another attempt", async () => {
    mockFetch({ "POST /api/auth/login": { status: 401, body: { error: "unauthorized", message: "Invalid token" } } });
    renderWithProviders(<Login productName="Test Dashboard" />);
    const input = screen.getByLabelText("Access token");
    await userEvent.type(input, "wrong{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid token");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("wrong");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("clears a previous error on the next attempt", async () => {
    let n = 0;
    mockFetch({ "POST /api/auth/login": () => (n++ === 0 ? { status: 401, body: { error: "unauthorized", message: "Invalid token" } } : { ok: true }) });
    renderWithProviders(<Login productName="Test Dashboard" />);
    await userEvent.type(screen.getByLabelText("Access token"), "abc{Enter}");
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
