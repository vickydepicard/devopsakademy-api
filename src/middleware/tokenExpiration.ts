import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const checkTokenExpiration = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = decoded.exp - now;

    // Si le token expire dans moins de 30 minutes, renvoyer un header
    if (expiresIn < 1800) {
      res.set('X-Token-Expiring-Soon', 'true');
    }
    
    next();
  } catch (error) {
    next();
  }
};