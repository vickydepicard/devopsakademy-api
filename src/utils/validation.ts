// Validation simple sans Zod
export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  success: boolean;
  data?: any;
  errors?: ValidationError[];
}

// Schémas de validation simples
export const registerSchema = {
  validate: (data: any): ValidationResult => {
    const errors: ValidationError[] = [];

    if (!data.email || !/\S+@\S+\.\S+/.test(data.email)) {
      errors.push({ path: 'email', message: 'Invalid email address' });
    }

    if (!data.password || data.password.length < 8) {
      errors.push({ path: 'password', message: 'Password must be at least 8 characters' });
    } else if (!/[A-Z]/.test(data.password)) {
      errors.push({ path: 'password', message: 'Password must contain at least one uppercase letter' });
    } else if (!/[a-z]/.test(data.password)) {
      errors.push({ path: 'password', message: 'Password must contain at least one lowercase letter' });
    } else if (!/[0-9]/.test(data.password)) {
      errors.push({ path: 'password', message: 'Password must contain at least one number' });
    }

    if (!data.first_name || data.first_name.length < 2) {
      errors.push({ path: 'first_name', message: 'First name must be at least 2 characters' });
    }

    if (!data.last_name || data.last_name.length < 2) {
      errors.push({ path: 'last_name', message: 'Last name must be at least 2 characters' });
    }

    if (data.role && !['student', 'instructor', 'admin'].includes(data.role)) {
      errors.push({ path: 'role', message: 'Role must be student, instructor, or admin' });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return {
      success: true,
      data: {
        email: data.email,
        password: data.password,
        first_name: data.first_name,
        last_name: data.last_name,
        role: data.role || 'student'
      }
    };
  }
};

export const loginSchema = {
  validate: (data: any): ValidationResult => {
    const errors: ValidationError[] = [];

    if (!data.email || !/\S+@\S+\.\S+/.test(data.email)) {
      errors.push({ path: 'email', message: 'Invalid email address' });
    }

    if (!data.password) {
      errors.push({ path: 'password', message: 'Password is required' });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return {
      success: true,
      data: {
        email: data.email,
        password: data.password
      }
    };
  }
};

export const validateData = (schema: any, data: any): ValidationResult => {
  return schema.validate(data);
};