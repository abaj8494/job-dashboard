import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { updateProfileImage } from "@/actions/auth.actions";
import path from "path";
import fs from "fs";

export const POST = async (req: NextRequest) => {
  const session = await auth();
  const dataPath = process.env.NODE_ENV !== "production" ? "data" : "/data";

  try {
    if (!session || !session.user) {
      return NextResponse.json(
        { error: "Not Authenticated" },
        { status: 401 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file || !file.name) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate file type
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed." },
        { status: 400 }
      );
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 5MB." },
        { status: 400 }
      );
    }

    // Create upload directory
    const uploadDir = path.join(dataPath, "files", "avatars");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename
    const ext = path.extname(file.name);
    const filename = `${session.accessToken.sub}-${Date.now()}${ext}`;
    const filePath = path.join(uploadDir, filename);

    // Save file
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    fs.writeFileSync(filePath, buffer);

    // Update user's image in database
    const result = await updateProfileImage(filePath);

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { success: true, path: filePath },
      { status: 200 }
    );
  } catch (error) {
    console.error("Profile image upload error:", error);
    return NextResponse.json(
      { error: "Failed to upload image" },
      { status: 500 }
    );
  }
};

export const GET = async (req: NextRequest) => {
  const session = await auth();

  try {
    if (!session || !session.user) {
      return NextResponse.json(
        { error: "Not Authenticated" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const filePath = searchParams.get("path");

    if (!filePath) {
      return NextResponse.json(
        { error: "File path is required" },
        { status: 400 }
      );
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    const fileContent = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const contentTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };

    return new NextResponse(fileContent, {
      headers: {
        "Content-Type": contentTypes[ext] || "image/jpeg",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    console.error("Profile image fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch image" },
      { status: 500 }
    );
  }
};
