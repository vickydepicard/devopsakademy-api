export interface User {
  id?: number;
  email: string;
  password_hash?: string;
  first_name: string;
  last_name: string;
  role: 'student' | 'instructor' | 'admin';
  is_active: boolean;
  email_verified: boolean;
  created_at?: Date;
  updated_at?: Date;
  last_login?: Date;
}

export interface JwtPayload {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  role: 'student' | 'instructor' | 'admin';
  iat?: number;
  exp?: number;
}

export interface UserProfile {
  id?: number;
  user_id: number;
  bio?: string;
  job_title?: string;
  company?: string;
  skills?: string[];
  github_url?: string;
  linkedin_url?: string;
  avatar_url?: string;
  country?: string;
  timezone?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  role?: 'student' | 'instructor' | 'admin';
}

export interface AuthResponse {
  success: boolean;
  message: string;
  data?: {
    user: Omit<User, 'password_hash'>;
    token: string;
  };
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
}