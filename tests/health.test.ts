import request from "supertest";
import app from "../src/app";

describe("Health Check", () => {
  it("GET /health → API OK", async () => {
    const res = await request(app).get("/health");

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("status", "OK");
    expect(res.body).toHaveProperty("message");
    expect(res.body).toHaveProperty("timestamp");
  });
});
