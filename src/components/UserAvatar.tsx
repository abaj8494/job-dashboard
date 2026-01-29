import Image from "next/image";
import { CurrentUser } from "@/models/user.model";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { User } from "lucide-react";

interface UserAvatarProps {
  user: CurrentUser | null;
  image?: string | null;
}

export default function UserAvatar({ user, image }: UserAvatarProps) {
  if (!user) return null;

  const imageSrc = image
    ? `/api/profile/image?path=${encodeURIComponent(image)}`
    : "/images/placeholder-user.jpg";

  return (
    <Avatar className="h-9 w-9">
      <AvatarImage src={imageSrc} alt="Avatar" />
      <AvatarFallback>
        <User className="h-5 w-5" />
      </AvatarFallback>
    </Avatar>
  );
}
