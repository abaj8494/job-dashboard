"use server";
import { AuthError } from "next-auth";
import { signIn } from "../auth";
import { delay } from "@/utils/delay";
import prisma from "@/lib/db";
import { getCurrentUser } from "@/utils/user.utils";
const bcrypt = require("bcryptjs");

export async function authenticate(
  prevState: string | undefined,
  formData: FormData
) {
  try {
    await delay(1000);
    await signIn("credentials", {
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      redirect: false,
    });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return "Invalid credentials.";
        default:
          return "Something went wrong.";
      }
    }
    throw error;
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser?.id) {
      return { success: false, message: "Not authenticated" };
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
    });

    if (!user) {
      return { success: false, message: "User not found" };
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return { success: false, message: "Current password is incorrect" };
    }

    // Hash new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: currentUser.id },
      data: { password: hashedPassword },
    });

    return { success: true };
  } catch (error) {
    console.error("Change password error:", error);
    return { success: false, message: "Failed to change password" };
  }
}

export async function updateProfileImage(
  imageUrl: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser?.id) {
      return { success: false, message: "Not authenticated" };
    }

    await prisma.user.update({
      where: { id: currentUser.id },
      data: { image: imageUrl },
    });

    return { success: true };
  } catch (error) {
    console.error("Update profile image error:", error);
    return { success: false, message: "Failed to update profile image" };
  }
}

export async function getUserImage(): Promise<string | null> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser?.id) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
      select: { image: true },
    });

    return user?.image || null;
  } catch (error) {
    return null;
  }
}
