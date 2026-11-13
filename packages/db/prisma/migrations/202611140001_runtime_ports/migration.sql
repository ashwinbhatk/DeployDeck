-- A live deployment cannot share its reserved host port with another deployment.
CREATE UNIQUE INDEX deployments_live_host_port ON deployments(host_port)
WHERE host_port IS NOT NULL AND status IN ('starting', 'healthy', 'stopping');
