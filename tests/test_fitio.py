from app.fitio import _power_value


def test_power_standard():
    assert _power_value({"timestamp": 1, "power": 245}) == 245


def test_power_running_developer_field():
    assert _power_value({"RP_Power": 312}) == 312


def test_power_prefers_standard():
    assert _power_value({"RP_Power": 300, "power": 250}) == 250


def test_power_ignores_derived_and_multi_value_fields():
    assert _power_value({"accumulated_power": 5000, "left_power_phase": (1.0, 2.0)}) is None
    assert _power_value({"max_power": 700}) is None
    assert _power_value({}) is None


def test_power_fallback_developer_name():
    assert _power_value({"Power_Watts": 180}) == 180
