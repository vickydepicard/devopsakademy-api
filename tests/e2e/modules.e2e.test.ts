import request from "supertest"
import app from "../../src/app"

describe("Modules API (E2E)", () => {
  it("GET /api/courses/:id/modules", async () => {
    const res = await request(app)
      .get("/api/courses/c_123/modules")
      .expect(200)

    expect(Array.isArray(res.body)).toBe(true)
  })
})
