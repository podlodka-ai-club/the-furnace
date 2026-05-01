ALTER TABLE attempts
  DROP CONSTRAINT IF EXISTS attempts_phase_check;

ALTER TABLE attempts
  ADD CONSTRAINT attempts_phase_check
  CHECK (phase IN ('spec','code','coder','review'));

ALTER TABLE attempts
  DROP CONSTRAINT IF EXISTS attempts_outcome_check;

ALTER TABLE attempts
  ADD CONSTRAINT attempts_outcome_check
  CHECK (outcome IN ('pending','passed','failed','stuck','tests-green','retry','dep-missing','design-question'));
