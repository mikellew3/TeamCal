-- Seed team members. Person colors render as a small dot on chips, NOT as
-- the chip background. Picked to be distinguishable on the warm-paper /
-- teal-soft canvas.
insert into team_members (name, email, color) values
  ('Alex Rivera',      'alex.rivera@example.com',    '#1f6b6b'),  -- teal (matches accent)
  ('Brianna Chen',     'b.chen@example.com',         '#7a4e2d'),  -- copper-brown
  ('Carlos Diaz',      'c.diaz@example.com',         '#2d5f3f'),  -- forest
  ('Dana Whitman',     'd.whitman@example.com',      '#8b2c3d'),  -- burgundy
  ('Evan Kowalski',    'e.kowalski@example.com',     '#4a4a7a'),  -- slate-violet
  ('Farrah Okonkwo',   'f.okonkwo@example.com',      '#a85a1f'),  -- burnt orange
  ('Gabe Thornton',    'g.thornton@example.com',     '#3a4a7a'),  -- institutional blue
  ('Hannah Liu',       'h.liu@example.com',          '#6b3a6e'),  -- plum
  ('Ian McAllister',   'i.mcallister@example.com',   '#5e7a2d'),  -- olive
  ('Jasmine Park',     'j.park@example.com',         '#a8492e'),  -- terracotta
  ('Kyle Harrington',  'k.harrington@example.com',   '#2d4f7a'),  -- steel blue
  ('Lila Brennan',     'l.brennan@example.com',      '#7a5a2d'),  -- ochre
  ('Marcus Webb',      'm.webb@example.com',         '#4a6e5e'),  -- sage-deep
  ('Nora Castellano',  'n.castellano@example.com',   '#6e2d4a'),  -- wine
  ('Owen Patel',       'o.patel@example.com',        '#3a5a6e'),  -- dusk blue
  ('Priya Shah',       'p.shah@example.com',         '#8b6e2d')   -- mustard
on conflict (email) do nothing;
