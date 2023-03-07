import { Readable } from "node:stream";
import type {
  EmailMessage,
  ExecutionContext,
  ReadableStream,
} from "@cloudflare/workers-types";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { compose, context, ResponseTransformer, rest } from "msw";
import { setupServer } from "msw/node";
import worker, { Environment } from "./index.js";

const telstraApiBaseUrl = "https://testing.api";

describe("email worker", () => {
  // Mock external API requests
  const server = setupServer(
    // Health check request
    rest.get(
      `${telstraApiBaseUrl}/messages/sms/healthcheck`,
      (_request, response, _context) => {
        return response(healthCheck("up"));
      }
    ),
    // Authentication request
    rest.post(
      `${telstraApiBaseUrl}/oauth/token`,
      (_request, response, _context) => {
        return response(oauthToken(true));
      }
    ),
    // Send SMS request
    rest.post(
      `${telstraApiBaseUrl}/messages/sms`,
      (_request, response, context_) => {
        return response(
          context_.status(201),
          context_.json({
            messages: [
              {
                to: "+61234567890",
                deliveryStatus: "MessageWaiting",
                messageId: "a-message-id",
                messageStatusURL:
                  "https://tapi.telstra.com/v2/messages/sms/a-message-id/status",
              },
            ],
            messageType: "SMS",
          })
        );
      }
    )
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  it("should run and log to console", async () => {
    const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {
      // No-op
    });

    const event = generateMockEmailMessage();
    const environment = generateMockEnvironment();
    const context = generateMockContext();
    await worker.email(event, environment, context);

    expect(consoleLogMock.mock.calls[0][0]).toMatchInlineSnapshot(
      '"SMS status: MessageWaiting (a-message-id)"'
    );
  });

  it("should log an error if using an invalid from address", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // No-op
      });

    const event = generateMockEmailMessage({
      from: "notvalid@somewhere.org",
    });
    const environment = generateMockEnvironment();
    const context = generateMockContext();
    await worker.email(event, environment, context);

    expect(consoleErrorMock.mock.calls[0][0]).toMatchInlineSnapshot(
      "\"Unexpected from address 'notvalid@somewhere.org'\""
    );
  });
});

describe("email worker with Telstra API status down", () => {
  // Mock external API requests
  const server = setupServer(
    rest.get(
      `${telstraApiBaseUrl}/messages/sms/healthcheck`,
      (_request, response, _context) => {
        return response(healthCheck("down"));
      }
    )
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  it("should log an error", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // No-op
      });

    const event = generateMockEmailMessage();
    const environment = generateMockEnvironment();
    const context = generateMockContext();
    await worker.email(event, environment, context);

    expect(consoleErrorMock.mock.calls[0][0]).toMatchInlineSnapshot(
      "\"Telstra API is: 'down'\""
    );
  });
});

describe("email worker with invalid Telstra API client", () => {
  // Mock external API requests
  const server = setupServer(
    // Health check request
    rest.get(
      `${telstraApiBaseUrl}/messages/sms/healthcheck`,
      (_request, response, _context) => {
        return response(healthCheck("up"));
      }
    ),
    // Authentication request
    rest.post(
      `${telstraApiBaseUrl}/oauth/token`,
      (_request, response, _context) => {
        return response(oauthToken(false));
      }
    )
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  it("should log an error", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // No-op
      });

    const event = generateMockEmailMessage();
    const environment = generateMockEnvironment();
    const context = generateMockContext();
    await worker.email(event, environment, context);

    expect(consoleErrorMock.mock.calls[0][0]).toMatchInlineSnapshot(
      "\"Fetching access token: 'Error: invalid_client''\""
    );
  });
});

describe("email worker with invalid subscription", () => {
  // Mock external API requests
  const server = setupServer(
    // Health check request
    rest.get(
      `${telstraApiBaseUrl}/messages/sms/healthcheck`,
      (_request, response, _context) => {
        return response(healthCheck("up"));
      }
    ),
    // Authentication request
    rest.post(
      `${telstraApiBaseUrl}/oauth/token`,
      (_request, response, _context) => {
        return response(oauthToken(true));
      }
    ),
    // Send SMS request
    rest.post(
      `${telstraApiBaseUrl}/messages/sms`,
      (_request, response, context_) => {
        return response(
          context_.status(200),
          context_.json({
            status: "EMPTY",
          })
        );
      }
    )
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  it("should log an error", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // No-op
      });

    const event = generateMockEmailMessage();
    const environment = generateMockEnvironment();
    const context = generateMockContext();
    await worker.email(event, environment, context);

    expect(consoleErrorMock.mock.calls[0][0]).toMatchInlineSnapshot(
      '"Sending SMS error: \'Error: 200 {\\"status\\":\\"EMPTY\\"}\'\'"'
    );
  });
});

describe.runIf(process.env.RUN_INTEGRATION_TEST)(
  "email worker integration test",
  () => {
    // Intercept external API requests for debugging
    const server = setupServer(
      // Health check request
      rest.get(
        "https://tapi.telstra.com/v2/messages/sms/healthcheck",
        (request, _response, _context) => {
          const response = request.passthrough();
          console.debug(response.status);
          return response;
        }
      ),
      // Authentication request
      rest.post(
        "https://tapi.telstra.com/v2/oauth/token",
        async (request, _response, _context) => {
          const response = request.passthrough();
          console.debug(response.status);
          return response;
        }
      ),
      // Send SMS request
      rest.post(
        "https://tapi.telstra.com/v2/messages/sms",
        (request, _response, _context) => {
          const response = request.passthrough();
          console.debug(response.status);
          return response;
        }
      )
    );

    beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
    afterAll(() => server.close());

    it("should run and send a real SMS", async () => {
      const event = generateMockEmailMessage();
      const environment = generateMockEnvironment({
        TELSTRA_API_CLIENT_ID: process.env.TELSTRA_API_CLIENT_ID,
        TELSTRA_API_CLIENT_SECRET: process.env.TELSTRA_API_CLIENT_SECRET,
        SMS_TO_ADDRESS: process.env.SMS_TO_ADDRESS,
        TELSTRA_API_BASE_URL: "https://tapi.telstra.com/v2",
      });
      const context_ = generateMockContext();
      await worker.email(event, environment, context_);
    });
  }
);

/**
 * Generates a mocked email message object.
 *
 * @param {Partial<EmailMessage>} options Optional message overrides.
 * @returns {EmailMessage} Mocked email message.
 */
function generateMockEmailMessage(
  options?: Partial<EmailMessage>
): EmailMessage {
  const readable = new Readable();
  readable.push("Test");
  readable.push(undefined);

  return {
    from: options?.from || "from@example.org",
    to: options?.to || "to@example.org",
    rawSize: options?.rawSize || 45_416,
    headers: new Headers({ subject: "1 NEW: goodies" }),
    raw: Readable.toWeb(readable) as ReadableStream,
    setReject() {
      // Do nothing
    },
    forward() {
      return Promise.resolve();
    },
  };
}

/**
 * Generates a mocked environment.
 *
 * @param {Partial<Environment>} options Optional overrides for the environment.
 * @returns {Environment} The mocked environment.
 */
function generateMockEnvironment(options?: Partial<Environment>): Environment {
  return {
    TELSTRA_API_BASE_URL: options?.TELSTRA_API_BASE_URL || telstraApiBaseUrl,
    TELSTRA_API_CLIENT_ID: options?.TELSTRA_API_CLIENT_ID || "valid_id",
    TELSTRA_API_CLIENT_SECRET: options?.TELSTRA_API_CLIENT_SECRET || "secret",
    SMS_TO_ADDRESS: options?.SMS_TO_ADDRESS || "+61234567890",
    FROM_ADDRESS: options?.FROM_ADDRESS || "from@example.org",
  };
}

/**
 * Generates a mocked execution context.
 *
 * @returns {ExecutionContext} The mocked context.
 */
function generateMockContext(): ExecutionContext {
  return {
    passThroughOnException() {
      // Do nothing
    },
    waitUntil() {
      // Do nothing
    },
  };
}

/**
 * Composes a health check API request response.
 *
 * @param {string} status The health check status to respond with.
 * @returns {ResponseTransformer} Composed response transformer.
 */
function healthCheck(status: string): ResponseTransformer {
  return compose(
    context.status(200),
    context.json({
      status: status,
    })
  );
}

/**
 * Composes a authentication API request response.
 *
 * @param {boolean} valid If the response should be authenticated or not.
 * @returns {ResponseTransformer} Composed response transformer.
 */
function oauthToken(valid: boolean): ResponseTransformer {
  return compose(
    context.status(valid ? 200 : 403),
    valid
      ? context.json({
          access_token: "ABCD1234",
          token_type: "Bearer",
          expires_in: "3599",
        })
      : context.json({
          error: "invalid_client",
        })
  );
}
