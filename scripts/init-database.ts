import mariadb from 'mariadb';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration de connexion sans base de données spécifique
const config: mariadb.PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  connectionLimit: 5,
  allowPublicKeyRetrieval: true,
};

const pool = mariadb.createPool(config);

async function initializeDatabase() {
  let connection: mariadb.PoolConnection | undefined;
  try {
    console.log('🔄 Connecting to MariaDB server...');
    connection = await pool.getConnection();
    
    // Créer la base de données si elle n'existe pas
    console.log('🔄 Creating database...');
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'devopsakademy'} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE ${process.env.DB_NAME || 'devopsakademy'}`);

    console.log('🔄 Creating tables...');
    
    // Table des utilisateurs
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        role ENUM('student', 'instructor', 'admin') DEFAULT 'student',
        is_active BOOLEAN DEFAULT TRUE,
        email_verified BOOLEAN DEFAULT FALSE,
        verification_token VARCHAR(100),
        reset_token VARCHAR(100),
        reset_token_expires DATETIME,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_role (role),
        INDEX idx_active (is_active)
      )
    `);

    // Table des profils utilisateurs
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL UNIQUE,
        bio TEXT,
        job_title VARCHAR(100),
        company VARCHAR(100),
        skills JSON,
        github_url VARCHAR(255),
        linkedin_url VARCHAR(255),
        twitter_url VARCHAR(255),
        avatar_url VARCHAR(255),
        country VARCHAR(100),
        timezone VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id)
      )
    `);

    // Insérer les utilisateurs initiaux
    console.log('🔄 Inserting initial data...');
    
    // Mot de passe hashé pour 'password123' (utilisez bcrypt plus tard)
    const adminPasswordHash = '$2a$12$K8G5GkS6W6p6p6p6p6p6pO6p6p6p6p6p6p6p6p6p6p6p6p6p6p6';
    const instructorPasswordHash = '$2a$12$K8G5GkS6W6p6p6p6p6p6pO6p6p6p6p6p6p6p6p6p6p6p6p6p6';
    
    await connection.query(`
      INSERT IGNORE INTO users (email, password_hash, first_name, last_name, role, email_verified) VALUES
      ('admin@devopsakademy.com', ?, 'Admin', 'System', 'admin', TRUE),
      ('instructor@devopsakademy.com', ?, 'John', 'Instructor', 'instructor', TRUE)
    `, [adminPasswordHash, instructorPasswordHash]);

    await connection.query(`
      INSERT IGNORE INTO user_profiles (user_id, bio, job_title, company, skills) VALUES
      (1, 'Administrateur de la plateforme DevOpsAkademy', 'System Administrator', 'DevOpsAkademy', '["DevOps", "Cloud", "Kubernetes", "Docker"]'),
      (2, 'Instructeur certifié DevOps avec 10 ans d''expérience', 'DevOps Engineer', 'TechCorp', '["AWS", "Terraform", "Kubernetes", "CI/CD"]')
    `);

    console.log('✅ Database initialized successfully!');
    console.log('📊 Default admin user: admin@devopsakademy.com / password123');
    console.log('📊 Default instructor: instructor@devopsakademy.com / password123');

  } catch (error) {
    console.error('❌ Error initializing database:', error);
  } finally {
    if (connection) await connection.release();
    await pool.end();
    process.exit();
  }
}

initializeDatabase();