import request from "supertest"
import app from "../../src/app"

describe("Courses API (E2E)", () => {
  it("GET /api/courses → 200", async () => {
    const res = await request(app)
      .get("/api/courses")
      .expect(200)

    expect(Array.isArray(res.body)).toBe(true)
  })
})
