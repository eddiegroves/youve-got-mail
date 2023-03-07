export interface Environment {
  TELSTRA_API_CLIENT_ID: string;
  TELSTRA_API_CLIENT_SECRET: string;
  TELSTRA_API_BASE_URL: string;
  SMS_TO_ADDRESS: string;
  FROM_ADDRESS: string;
}

export default {
  async email(
    message: EmailMessage,
    environment: Environment,
    _context: ExecutionContext
  ): Promise<void> {
    const baseUrl = environment.TELSTRA_API_BASE_URL;

    /**
     * Performs a health check API call to Telstra Messaging API.
     */
    async function healthCheckTelstraApi(): Promise<string> {
      const response = await fetch(`${baseUrl}/messages/sms/healthcheck`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      const responseBody = (await response.json()) as HealthCheckResponse;
      return responseBody.status;
    }

    /**
     * Authenticates to Telstra Messaging API.
     */
    async function authenticateTelstraApi(): Promise<string> {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "NSMS",
          client_id: environment.TELSTRA_API_CLIENT_ID,
          client_secret: environment.TELSTRA_API_CLIENT_SECRET,
        }),
      });

      if (response.status === 200) {
        const responseBody = (await response.json()) as OAuthTokenResponse;
        return responseBody.access_token;
      } else {
        const responseBody = (await response.json()) as ErrorResponse;
        throw new Error(responseBody.error);
      }
    }

    /**
     * Send an SMS message using Telstra Messaging API.
     *
     * @param {string} accessToken The access token for authenticating the
     * request with.
     * @param {string} body The SMS message body to send.
     */
    async function sendSms(
      accessToken: string,
      body: string
    ): Promise<SendSmsResponse> {
      const response = await fetch(`${baseUrl}/messages/sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          to: "+61406817184",
          body: body,
        }),
      });

      if (response.status === 201) {
        return (await response.json()) as SendSmsResponse;
      } else {
        const responseBody = await response.text();
        throw new Error(`${response.status} ${responseBody}`);
      }
    }

    // Validate the email from address is the expected source
    if (message.from !== environment.FROM_ADDRESS) {
      console.error(`Unexpected from address '${message.from}'`);
      return;
    }

    // Check if external SMS API is up
    const healthCheck = await healthCheckTelstraApi();
    if (healthCheck !== "up") {
      console.error(`Telstra API is: '${healthCheck}'`);
      return;
    }

    // Authenticate to SMS API
    let accessToken = "";
    try {
      accessToken = await authenticateTelstraApi();
    } catch (error) {
      console.error(`Fetching access token: '${error}''`);
      return;
    }

    // Send SMS message
    try {
      const subject = message.headers.get("subject");
      const smsResponse = await sendSms(
        accessToken,
        `${subject} from ${message.from}`
      );
      console.log(
        `SMS status: ${smsResponse.messages[0].deliveryStatus} (${smsResponse.messages[0].messageId})`
      );
    } catch (error) {
      console.error(`Sending SMS error: '${error}''`);
    }
  },
};

// https://dev.telstra.com/docs/messaging-api/apiReference/apiReferenceOverviewEndpoints#RetrieveSMSStatus
type HealthCheckResponse = {
  status: "up" | "down";
};

// https://dev.telstra.com/docs/messaging-api/apiReference/apiReferenceOverviewEndpoints#GenerateOAuth2token
type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: string;
};

type ErrorResponse = {
  error: string;
};

// https://dev.telstra.com/docs/messaging-api/apiReference/apiReferenceOverviewEndpoints#SendSMS
type SmsMessage = {
  to: string;
  deliveryStatus: string;
  messageId: string;
  messageStatusURL: string;
};

type SendSmsResponse = {
  messages: SmsMessage[];
  messageType: string;
};
