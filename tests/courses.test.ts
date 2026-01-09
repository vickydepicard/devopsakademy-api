import request from "supertest"
import app from "../src/app"

describe("Courses API", () => {
  it("should get paginated courses list", async () => {
    const res = await request(app).get("/api/courses")

    expect(res.status).toBe(200)

    // structure globale
    expect(res.body).toHaveProperty("success")
    expect(res.body).toHaveProperty("data")
    expect(res.body).toHaveProperty("pagination")

    // contenu
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)

    // pagination minimale
    expect(res.body.pagination).toHaveProperty("page")
    expect(res.body.pagination).toHaveProperty("limit")
  })
})
