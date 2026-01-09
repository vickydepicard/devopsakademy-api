import request from "supertest";
import app from "../src/app";

describe("Auth API", () => {
  it("POST /api/auth/login → 401 si credentials invalides", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "fake@mail.com",
        password: "wrongpassword",
      });

    expect(res.statusCode).toBe(401);
  });
});
