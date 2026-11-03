import { describe, expect, it } from "vitest";
import { uniqueCalendarThumbnails } from "./calendar-thumbnails";

describe("uniqueCalendarThumbnails", () => {
  it("shows a shared fallback image once while retaining each item name", () => {
    const items = [
      { name: "Camera", image: "/same.jpg" },
      { name: "Lens", image: "/same.jpg" },
      { name: "Camera", image: "/same.jpg" },
      { name: "Tripod", image: "/tripod.jpg" },
    ];
    expect(uniqueCalendarThumbnails(items)).toEqual([
      { name: "Camera, Lens", image: "/same.jpg" },
      { name: "Tripod", image: "/tripod.jpg" },
    ]);
    expect(items[0].name).toBe("Camera");
  });

  it("retains placeholders for distinct items without photos", () => {
    expect(uniqueCalendarThumbnails([
      { name: "Camera", image: null },
      { name: "Lens", image: null },
    ])).toHaveLength(2);
  });
});
