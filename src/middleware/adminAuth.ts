import { authorizeRoles } from './auth';

// Middleware pour les routes admin
export const adminAuth = authorizeRoles(['admin']);