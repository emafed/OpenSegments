import numpy as np

from app.geo import angle_diff, bearing, cumulative_distances, dist_to_point, haversine


def test_haversine_one_degree_latitude():
    d = haversine(45.0, 9.0, 46.0, 9.0)
    assert abs(float(d) - 111195) < 200


def test_haversine_symmetric():
    a = haversine(45.1, 9.2, 45.3, 9.4)
    b = haversine(45.3, 9.4, 45.1, 9.2)
    assert abs(float(a) - float(b)) < 1e-6


def test_cumulative_distances_with_nan():
    lat = np.array([45.0, np.nan, 45.001])
    lon = np.array([9.0, np.nan, 9.0])
    d = cumulative_distances(lat, lon)
    assert d[0] == 0.0
    assert d[1] == 0.0
    assert abs(d[2] - 111.19) < 0.5


def test_dist_to_point():
    d = dist_to_point(np.array([45.0, 45.001]), np.array([9.0, 9.0]), 45.0, 9.0)
    assert d[0] == 0.0
    assert abs(d[1] - 111.19) < 0.5


def test_dist_to_point_ignores_invalid():
    d = dist_to_point(np.array([np.nan, 45.0]), np.array([np.nan, 9.0]), 45.0, 9.0)
    assert d[0] == np.inf
    assert d[1] == 0.0


def test_bearing_east():
    b = bearing(45.0, 9.0, 45.0, 9.001)
    assert abs(float(b) - 90.0) < 0.5


def test_angle_diff():
    assert angle_diff(10, 350) == 20
    assert angle_diff(0, 180) == 180
    assert angle_diff(90, 90) == 0
