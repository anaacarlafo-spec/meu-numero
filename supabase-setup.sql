-- ═══════════════════════════════════════════════════════
-- Meu Número — Setup do Supabase
-- Execute este SQL no SQL Editor do seu projeto Supabase
-- ═══════════════════════════════════════════════════════

-- 1. Tabela de perfil da criadora
CREATE TABLE IF NOT EXISTS perfil (
  id        INT PRIMARY KEY DEFAULT 1,
  nome      TEXT DEFAULT 'Criadora',
  foto_url  TEXT,
  status    TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insere o único registro da criadora (se não existir)
INSERT INTO perfil (id, nome, status)
VALUES (1, 'Criadora', 'offline')
ON CONFLICT (id) DO NOTHING;

-- 2. Tabela de sinalização WebRTC
CREATE TABLE IF NOT EXISTS sinalizacao (
  id           BIGSERIAL PRIMARY KEY,
  role         TEXT,          -- 'client'
  status       TEXT DEFAULT 'calling', -- calling | active | rejected | ended
  offer        TEXT,          -- JSON do RTCSessionDescription offer
  answer       TEXT,          -- JSON do RTCSessionDescription answer
  ice_client   TEXT,          -- JSON array de ICE candidates do cliente
  ice_criadora TEXT,          -- JSON array de ICE candidates da criadora
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 3. Habilita Realtime nas duas tabelas
ALTER PUBLICATION supabase_realtime ADD TABLE perfil;
ALTER PUBLICATION supabase_realtime ADD TABLE sinalizacao;

-- 4. RLS (Row Level Security)
-- perfil: leitura pública, escrita apenas autenticado
ALTER TABLE perfil ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leitura publica perfil"  ON perfil FOR SELECT USING (true);
CREATE POLICY "update autenticado perfil" ON perfil FOR UPDATE USING (auth.role() = 'authenticated');

-- sinalizacao: qualquer um pode inserir (cliente) e ler; update apenas autenticado ou dono
ALTER TABLE sinalizacao ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert livre sinalizacao"  ON sinalizacao FOR INSERT WITH CHECK (true);
CREATE POLICY "select livre sinalizacao"  ON sinalizacao FOR SELECT USING (true);
CREATE POLICY "update livre sinalizacao"  ON sinalizacao FOR UPDATE USING (true);

-- 5. Bucket de fotos (execute no Storage > Buckets se preferir pela UI)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('fotos', 'fotos', true) ON CONFLICT DO NOTHING;
