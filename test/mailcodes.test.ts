/**
 * Security-code extraction — offline, against the real Greenhouse template
 * a real code email ("Security code for your application to <company>").
 */
import { describe, expect, test } from "bun:test";
import { extractSecurityCode } from "../src/pipeline/mailcodes.ts";
import { CODE_PROMPT } from "../src/pipeline/submit.ts";

const GREENHOUSE = `greenhouse Recruiting
Hi the candidate,
Copy and paste this code into the security code field on your application:
VMYFYBCI
After you enter the code, resubmit your application.`;

describe("extractSecurityCode", () => {
  test("pulls the code from the real Greenhouse template", () => {
    expect(extractSecurityCode(GREENHOUSE)).toBe("VMYFYBCI");
  });

  test("works through HTML markup", () => {
    const html = `<p>Copy and paste this code into the security code field on your application:</p><h1 style="x">VMYFYBCI</h1>`;
    expect(extractSecurityCode(html)).toBe("VMYFYBCI");
  });

  test("ANTI: template words are never mistaken for the code", () => {
    expect(extractSecurityCode("greenhouse RECRUITING GREENHOUSE newsletter")).toBeNull();
  });

  test("returns null when there is no code sentence", () => {
    expect(extractSecurityCode("Thanks for applying to Northstar Labs. We will be in touch.")).toBeNull();
  });
});

describe("live template shape", () => {
  test("REGRESSION: mixed-case code in HTML, company name before it, returned with its case intact", () => {
    const html = `<html><head><style>.code{text-transform:uppercase} .x{color:#FFFFFF}</style></head><body>
      <p>Copy and paste this code into the security code field on your application to Northstar Labs:</p>
      <p class="code">vMy3yBcI</p><p>Greenhouse Recruiting</p></body></html>`;
    // Case is preserved: the code is case-sensitive; the CSS upper-casing is display only.
    expect(extractSecurityCode(html)).toBe("vMy3yBcI");
  });

  test("ANTI: ordinary words after the anchor are not taken as the code", () => {
    expect(extractSecurityCode("Enter the security code shortly. Applying Security Recruits")).toBeNull();
  });
});

describe("the code prompt is recognised in the form's language", () => {
  test("Portuguese and Spanish prompts count as a code prompt", () => {
    for (const text of [
      "Um código de verificação foi enviado para jordan.reis@example.com. Para enviar sua inscrição, digite o código de 8 caracteres",
      "Código de segurança",
      "Introduce el código de 8 caracteres enviado a tu correo",
      "A verification code was sent to your email",
    ]) expect(CODE_PROMPT.test(text)).toBe(true);
  });

  test("ANTI: an ordinary Portuguese form mentions no code", () => {
    expect(CODE_PROMPT.test("Qual é o seu CPF? Código postal do endereço")).toBe(false);
  });
});
