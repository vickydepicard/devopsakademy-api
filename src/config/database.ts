import mariadb from 'mariadb';
import dotenv from 'dotenv';

dotenv.config();

const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'devopsakademy',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'devopsakademy',
  connectionLimit: 10,
  acquireTimeout: 60000,
  charset: 'utf8mb4',
  timezone: 'UTC',
  allowPublicKeyRetrieval: true,
  connectTimeout: 60000,
  idleTimeout: 300000,
  checkDuplicate: false,
});

export const getConnection = async (): Promise<mariadb.PoolConnection> => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connected to MariaDB database');
    return connection;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
};

export const query = async (sql: string, params: any[] = []): Promise<any> => {
  let connection: mariadb.PoolConnection | undefined;
  try {
    connection = await pool.getConnection();
    const result = await connection.query(sql, params);
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  } finally {
    if (connection) await connection.release();
  }
};

// Optionnel : tester la connexion
export const testConnection = async (): Promise<boolean> => {
  try {
    const connection = await getConnection();
    await connection.release();
    return true;
  } catch (error) {
    return false;
  }
};

export default pool;
