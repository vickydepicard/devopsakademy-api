import swaggerJSDoc from "swagger-jsdoc"

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "DevOpsAkademy API",
      version: "1.0.0",
      description: "API officielle DevOpsAkademy",
    },
    servers: [
      {
        url: "http://localhost:5000",
        description: "Local server",
      },
    ],

    // 🔐 SECURITY
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },

      // 🧠 SCHEMAS
      schemas: {
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              example: "admin@devopsakademy.com",
            },
            password: {
              type: "string",
              example: "StrongPassword123!",
            },
          },
        },

        AuthResponse: {
          type: "object",
          properties: {
            accessToken: {
              type: "string",
            },
            refreshToken: {
              type: "string",
            },
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                email: { type: "string" },
                role: { type: "string" },
              },
            },
          },
        },

        ErrorResponse: {
          type: "object",
          properties: {
            message: {
              type: "string",
            },
          },
        },
      },
    },
  },

  apis: ["./src/routes/*.ts", "./src/app.ts"],
})

export default swaggerSpec
